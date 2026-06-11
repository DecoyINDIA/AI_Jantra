import type { DataSnapshot } from "./schema.js";

export interface AnomalyFinding {
  kpiId: string;
  period: string; // e.g. "2026-05" or "2026-05-01"
  actual: number;
  expectedLow: number;
  expectedHigh: number;
  severity: number; // 0 to 1
  methodsAgreed: ("stl-mad" | "forecast-band")[];
  suppressionChecked: string[];
  drivers: { segment: string; contribution: number }[];
  confirmOrRefute: string;
}

/**
 * Robust median calculation
 */
function getMedian(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Robust Median Absolute Deviation (MAD)
 */
function getMad(arr: number[], median: number): number {
  if (!arr.length) return 0;
  const absDeviations = arr.map((x) => Math.abs(x - median));
  return getMedian(absDeviations);
}

/**
 * Simple seasonal decomposition (STL-like fallback for short series)
 * Y_t = Trend_t + Seasonal_t + Residual_t
 */
export function decomposeSeries(
  series: number[],
  period: number,
): { trend: number[]; seasonal: number[]; residual: number[] } {
  const n = series.length;
  const trend = new Array(n).fill(0);
  const seasonal = new Array(n).fill(0);
  const residual = new Array(n).fill(0);

  if (n < period * 2) {
    // Insufficient history for proper seasonal decomposition, use trend only
    const window = Math.max(3, Math.floor(n / 4) | 1); // odd window
    const half = Math.floor(window / 2);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let w = -half; w <= half; w++) {
        if (i + w >= 0 && i + w < n) {
          sum += series[i + w]!;
          count++;
        }
      }
      trend[i] = sum / count;
      residual[i] = series[i]! - trend[i];
    }
    return { trend, seasonal, residual };
  }

  // 1. Estimate Trend using moving average (window = period)
  const half = Math.floor(period / 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let w = -half; w <= half; w++) {
      const idx = i + w;
      if (idx >= 0 && idx < n) {
        sum += series[idx]!;
        count++;
      }
    }
    trend[i] = sum / count;
  }

  // 2. Estimate Seasonal component
  const detrended = series.map((y, idx) => y - trend[idx]!);
  const seasonalAverages = new Array(period).fill(0);
  const seasonalCounts = new Array(period).fill(0);

  for (let i = 0; i < n; i++) {
    const cycleIdx = i % period;
    seasonalAverages[cycleIdx] += detrended[i]!;
    seasonalCounts[cycleIdx]++;
  }

  const rawSeasonal = seasonalAverages.map((sum, idx) => sum / (seasonalCounts[idx] || 1));
  const seasonalMean = rawSeasonal.reduce((a, b) => a + b, 0) / period;
  const normalizedSeasonal = rawSeasonal.map((s) => s - seasonalMean);

  for (let i = 0; i < n; i++) {
    seasonal[i] = normalizedSeasonal[i % period]!;
  }

  // 3. Compute Residual
  for (let i = 0; i < n; i++) {
    residual[i] = series[i]! - trend[i]! - seasonal[i]!;
  }

  return { trend, seasonal, residual };
}

/**
 * Compute contributing drivers for the anomaly.
 * Evaluates the segment-level changes from prior period.
 */
export function computeDrivers(
  kpiId: string,
  period: string,
  snapshot: DataSnapshot,
  priorPeriod: string | null,
): { segment: string; contribution: number }[] {
  const drivers: { segment: string; contribution: number }[] = [];

  // Drilldown on orders/sales/revenue
  if (kpiId === "revenue" || kpiId === "orders_count" || kpiId === "billings") {
    const isRevenue = kpiId === "revenue" || kpiId === "billings";
    const currentOrders = snapshot.orders.filter((o) => o.orderDate.startsWith(period));
    const priorOrders = priorPeriod
      ? snapshot.orders.filter((o) => o.orderDate.startsWith(priorPeriod))
      : [];

    const getOrdersBySegment = (ordersList: typeof snapshot.orders, key: "productId" | "channelId" | "customerId") => {
      const map = new Map<string, { count: number; amount: number }>();
      for (const o of ordersList) {
        const id = o[key];
        const exist = map.get(id) ?? { count: 0, amount: 0 };
        exist.count += o.quantity || 1;
        exist.amount += o.amount;
        map.set(id, exist);
      }
      return map;
    };

    const currentProd = getOrdersBySegment(currentOrders, "productId");
    const priorProd = getOrdersBySegment(priorOrders, "productId");

    let maxProdChange = 0;
    let maxProdName = "";
    const allProdIds = new Set([...currentProd.keys(), ...priorProd.keys()]);

    for (const prodId of allProdIds) {
      const cur = currentProd.get(prodId) ?? { count: 0, amount: 0 };
      const pri = priorProd.get(prodId) ?? { count: 0, amount: 0 };
      const diff = isRevenue ? cur.amount - pri.amount : cur.count - pri.count;

      if (Math.abs(diff) > Math.abs(maxProdChange)) {
        maxProdChange = diff;
        const product = snapshot.products.find((p) => p.id === prodId);
        maxProdName = product ? product.name : prodId;
      }
    }

    const currentChan = getOrdersBySegment(currentOrders, "channelId");
    const priorChan = getOrdersBySegment(priorOrders, "channelId");

    let maxChanChange = 0;
    let maxChanName = "";
    const allChanIds = new Set([...currentChan.keys(), ...priorChan.keys()]);

    for (const chanId of allChanIds) {
      const cur = currentChan.get(chanId) ?? { count: 0, amount: 0 };
      const pri = priorChan.get(chanId) ?? { count: 0, amount: 0 };
      const diff = isRevenue ? cur.amount - pri.amount : cur.count - pri.count;

      if (Math.abs(diff) > Math.abs(maxChanChange)) {
        maxChanChange = diff;
        const channel = snapshot.channels.find((c) => c.id === chanId);
        maxChanName = channel ? channel.name : chanId;
      }
    }

    const totalKpiChange = isRevenue
      ? currentOrders.reduce((acc, o) => acc + o.amount, 0) - priorOrders.reduce((acc, o) => acc + o.amount, 0)
      : currentOrders.length - priorOrders.length;

    const denom = totalKpiChange === 0 ? 1 : totalKpiChange;

    if (maxProdName) {
      drivers.push({
        segment: `Product: ${maxProdName}`,
        contribution: Number((maxProdChange / denom).toFixed(2)),
      });
    }
    if (maxChanName) {
      drivers.push({
        segment: `Channel: ${maxChanName}`,
        contribution: Number((maxChanChange / denom).toFixed(2)),
      });
    }
  }

  // Drilldown on expenses (by category)
  if (kpiId === "expenses" || kpiId.includes("expense")) {
    const currentExp = snapshot.expenses.filter((e) => e.expenseDate.startsWith(period));
    const priorExp = priorPeriod
      ? snapshot.expenses.filter((e) => e.expenseDate.startsWith(priorPeriod))
      : [];

    const getExpensesByCategory = (expList: typeof snapshot.expenses) => {
      const map = new Map<string, number>();
      for (const e of expList) {
        map.set(e.category, (map.get(e.category) || 0) + e.amount);
      }
      return map;
    };

    const currentCat = getExpensesByCategory(currentExp);
    const priorCat = getExpensesByCategory(priorExp);
    const allCategories = new Set([...currentCat.keys(), ...priorCat.keys()]);

    let maxChange = 0;
    let maxCategory = "";
    for (const cat of allCategories) {
      const cur = currentCat.get(cat) || 0;
      const pri = priorCat.get(cat) || 0;
      const diff = cur - pri;
      if (Math.abs(diff) > Math.abs(maxChange)) {
        maxChange = diff;
        maxCategory = cat;
      }
    }

    const totalChange = currentExp.reduce((acc, e) => acc + e.amount, 0) - priorExp.reduce((acc, e) => acc + e.amount, 0);
    const denom = totalChange === 0 ? 1 : totalChange;

    if (maxCategory) {
      drivers.push({
        segment: `Expense Category: ${maxCategory}`,
        contribution: Number((maxChange / denom).toFixed(2)),
      });
    }
  }

  // Drilldown on SaaS subscription events (by type / MRR change)
  if (kpiId === "subscriptions" || kpiId.includes("churn") || kpiId.includes("signup") || kpiId === "mrr") {
    const currentEvents = snapshot.subscription_events.filter((e) => e.eventDate.startsWith(period));
    const priorEvents = priorPeriod
      ? snapshot.subscription_events.filter((e) => e.eventDate.startsWith(priorPeriod))
      : [];

    const getEventsByType = (eventList: typeof snapshot.subscription_events) => {
      const map = new Map<string, { count: number; value: number }>();
      for (const e of eventList) {
        const exist = map.get(e.type) ?? { count: 0, value: 0 };
        exist.count++;
        exist.value += e.monthlyValue;
        map.set(e.type, exist);
      }
      return map;
    };

    const currentType = getEventsByType(currentEvents);
    const priorType = getEventsByType(priorEvents);
    const allTypes = new Set([...currentType.keys(), ...priorType.keys()]);

    let maxChange = 0;
    let maxTypeName = "";
    for (const t of allTypes) {
      const cur = currentType.get(t) ?? { count: 0, value: 0 };
      const pri = priorType.get(t) ?? { count: 0, value: 0 };
      const diff = cur.value - pri.value;
      if (Math.abs(diff) > Math.abs(maxChange)) {
        maxChange = diff;
        maxTypeName = t;
      }
    }

    const totalChange = currentEvents.reduce((acc, e) => acc + e.monthlyValue, 0) - priorEvents.reduce((acc, e) => acc + e.monthlyValue, 0);
    const denom = totalChange === 0 ? 1 : totalChange;

    if (maxTypeName) {
      drivers.push({
        segment: `Subscription Event: ${maxTypeName}`,
        contribution: Number((maxChange / denom).toFixed(2)),
      });
    }
  }

  if (!drivers.length) {
    drivers.push({ segment: "General business trend", contribution: 1.0 });
  }

  return drivers;
}

/**
 * Scan a single metric series for anomalies
 */
export function scanMetricAnomalies(
  kpiId: string,
  series: number[],
  timestamps: string[],
  sensitivity: "low" | "medium" | "high",
  seasonalPeriod: number,
  knownEvents: { name: string; date: string; type: "promo" | "holiday" | "one-off" }[],
  snapshot: DataSnapshot,
  minHistory: number,
): AnomalyFinding[] {
  const findings: AnomalyFinding[] = [];
  const n = series.length;
  if (n < minHistory) return [];

  const zThreshold = sensitivity === "low" ? 3.5 : sensitivity === "high" ? 2.5 : 3.0;
  const kThreshold = sensitivity === "low" ? 3.0 : sensitivity === "high" ? 2.0 : 2.5;

  // Run Method A: STL-MAD
  const { trend, residual } = decomposeSeries(series, seasonalPeriod);
  const resMedian = getMedian(residual);
  const resMad = getMad(residual, resMedian);
  const madFactor = 1.4826;

  // Use dynamic p based on seasonal history availability
  const p = n >= seasonalPeriod && seasonalPeriod > 0 ? seasonalPeriod : 1;

  // Run Method B: Seasonal Naive / ETS Forecast Band
  const forecastErrors: number[] = [];
  for (let i = p; i < n; i++) {
    const forecast = series[i - p]!;
    forecastErrors.push(series[i]! - forecast);
  }
  const errorMedian = getMedian(forecastErrors);
  const errorMad = getMad(forecastErrors, errorMedian);

  // Robust minimum scale calculation to prevent zero-width expected bands
  const seriesMedian = Math.abs(getMedian(series));
  const minScale = Math.max(0.01 * seriesMedian, 0.01);

  const scale = Math.max(resMad * madFactor, minScale);
  const forecastScale = Math.max(errorMad * madFactor, minScale);

  const targetIdx = n - 1;
  const timestamp = timestamps[targetIdx]!;
  const actual = series[targetIdx]!;

  // Method A evaluation
  const res = residual[targetIdx]!;
  const zScore = (res - resMedian) / scale;
  const stlAgrees = Math.abs(zScore) > zThreshold;

  // Method B evaluation
  const expectedForecast = targetIdx >= p ? series[targetIdx - p]! : trend[targetIdx]!;
  const forecastAgrees = Math.abs(actual - expectedForecast) > kThreshold * forecastScale;

  if (stlAgrees && forecastAgrees) {
    // Check known-event suppression
    const suppressions: string[] = [];
    let isSuppressed = false;
    for (const event of knownEvents) {
      if (event.date.startsWith(timestamp)) {
        suppressions.push(event.name);
        if (event.type === "promo" || event.type === "holiday") {
          isSuppressed = true;
        }
      }
    }

    if (!isSuppressed) {
      const priorPeriod = targetIdx > 0 ? timestamps[targetIdx - 1]! : null;
      const drivers = computeDrivers(kpiId, timestamp, snapshot, priorPeriod);

      const absZ = Math.min(5, Math.abs(zScore));
      const surpriseRatio = absZ / 5;
      const priorValue = targetIdx > 0 ? series[targetIdx - 1]! : actual;
      const pctChange = priorValue === 0 ? 1 : Math.abs(actual - priorValue) / Math.abs(priorValue);
      const impactRatio = Math.min(1.0, pctChange);
      const severity = surpriseRatio * 0.6 + impactRatio * 0.4;

      const direction = actual > expectedForecast ? "increase" : "decrease";
      findings.push({
        kpiId,
        period: timestamp,
        actual,
        expectedLow: Number((expectedForecast - kThreshold * forecastScale).toFixed(2)),
        expectedHigh: Number((expectedForecast + kThreshold * forecastScale).toFixed(2)),
        severity: Number(severity.toFixed(2)),
        methodsAgreed: ["stl-mad", "forecast-band"],
        suppressionChecked: suppressions,
        drivers,
        confirmOrRefute: `Verify against ${kpiId} logs to confirm if the ${direction} of ${actual} is valid.`,
      });
    }
  }

  return findings;
}
