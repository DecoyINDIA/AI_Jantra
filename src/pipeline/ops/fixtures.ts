import type { DataSnapshot, Order, OrderLine, Invoice, Payment, Expense, SubscriptionEvent, Customer, Product, Channel, Calendar } from "./schema.js";

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function createRandom(seedString: string) {
  let h = 0;
  for (let i = 0; i < seedString.length; i++) {
    h = Math.imul(31, h) + seedString.charCodeAt(i) | 0;
  }
  return function() {
    h = Math.imul(h ^ 123456789, 2654435769) | 0;
    return (h >>> 0) / 4294967296;
  };
}

export function generateSyntheticData(clientId: string): DataSnapshot {
  const random = createRandom(clientId + "_seed");
  const snapshot: DataSnapshot = {
    orders: [],
    order_lines: [],
    invoices: [],
    payments: [],
    expenses: [],
    subscription_events: [],
    customers: [],
    products: [],
    channels: [
      { id: "stripe", name: "Stripe Checkout" },
      { id: "shopify", name: "Shopify Storefront" },
      { id: "pos", name: "Retail POS" },
      { id: "xero", name: "Xero Billing" },
    ],
    calendar: [],
  };

  const startYear = 2025;
  const startMonth = 1; // January 2025
  const endYear = 2026;
  const endMonth = 6; // June 2026

  // 1. Generate Calendar
  let currentYear = startYear;
  let currentMonth = startMonth;
  while (true) {
    const days = getDaysInMonth(currentYear, currentMonth);
    for (let d = 1; d <= days; d++) {
      const dateStr = `${currentYear}-${pad(currentMonth)}-${pad(d)}`;
      
      // Basic holidays
      const isHoliday = (currentMonth === 12 && d === 25) || (currentMonth === 1 && d === 1);
      // Summer promo in July
      const isPromo = currentMonth === 7 && d >= 10 && d <= 15;

      snapshot.calendar.push({
        date: dateStr,
        week: Math.ceil(d / 7),
        month: currentMonth,
        year: currentYear,
        isHoliday,
        isPromo,
      });
    }

    if (currentYear === endYear && currentMonth === endMonth) break;
    currentMonth++;
    if (currentMonth > 12) {
      currentMonth = 1;
      currentYear++;
    }
  }

  // 2. Generate Client-Specific Mock Data
  if (clientId === "ecommerce-client") {
    // E-commerce store
    // Generate Customers
    for (let i = 1; i <= 50; i++) {
      snapshot.customers.push({
        id: `c_${i}`,
        name: `Customer ${i}`,
        cohortMonth: "2025-01",
      });
    }
    // Generate Products
    snapshot.products.push(
      { id: "p_1", name: "Premium Widget", category: "Electronics", sku: "WID-001" },
      { id: "p_2", name: "Standard Gadget", category: "Electronics", sku: "GAD-002" },
    );

    // Monthly orders from 2025-01 to 2026-06
    let orderIdSeq = 1;
    currentYear = startYear;
    currentMonth = startMonth;

    while (true) {
      const monthStr = `${currentYear}-${pad(currentMonth)}`;
      const days = getDaysInMonth(currentYear, currentMonth);

      // Base order volume per month
      let numOrders = 30;
      let orderMultiplier = 1.0;

      // Real demand spike in December
      if (currentMonth === 12) {
        orderMultiplier = 2.2;
      }
      // Promo spike in July (July promo event)
      if (currentMonth === 7) {
        orderMultiplier = 1.5;
      }

      numOrders = Math.floor(numOrders * orderMultiplier);

      for (let o = 0; o < numOrders; o++) {
        const d = Math.floor(random() * days) + 1;
        const dateStr = `${currentYear}-${pad(currentMonth)}-${pad(d)}`;
        const customer = snapshot.customers[Math.floor(random() * snapshot.customers.length)]!;
        const product = snapshot.products[Math.floor(random() * snapshot.products.length)]!;
        
        const isPromoDay = currentMonth === 7 && d >= 10 && d <= 15;
        const amount = product.id === "p_1" ? 100 : 50;
        const finalAmount = isPromoDay ? amount * 0.8 : amount; // 20% discount on promo day

        const orderId = `ord_${orderIdSeq++}`;
        snapshot.orders.push({
          id: orderId,
          customerId: customer.id,
          productId: product.id,
          channelId: "shopify",
          amount: finalAmount,
          currency: "USD",
          orderDate: dateStr,
          quantity: 1,
        });

        snapshot.order_lines.push({
          id: `line_${orderId}_1`,
          orderId,
          productId: product.id,
          amount: finalAmount,
          quantity: 1,
        });
      }

      // Add regular COGS and Operating Expenses
      snapshot.expenses.push(
        {
          id: `exp_${monthStr}_cogs`,
          category: "cogs",
          amount: Number((numOrders * 20 * orderMultiplier).toFixed(2)),
          currency: "USD",
          expenseDate: `${monthStr}-28`,
          description: "Cost of goods sold",
        },
        {
          id: `exp_${monthStr}_rent`,
          category: "rent",
          amount: 500,
          currency: "USD",
          expenseDate: `${monthStr}-01`,
          description: "Warehouse Rent",
        },
      );

      if (currentYear === endYear && currentMonth === endMonth) break;
      currentMonth++;
      if (currentMonth > 12) {
        currentMonth = 1;
        currentYear++;
      }
    }
  } else if (clientId === "saas-client") {
    // SaaS Subscription
    for (let i = 1; i <= 100; i++) {
      snapshot.customers.push({
        id: `c_${i}`,
        name: `Enterprise Client ${i}`,
        cohortMonth: `2025-${pad((i % 12) + 1)}`,
      });
    }

    let eventIdSeq = 1;
    currentYear = startYear;
    currentMonth = startMonth;

    while (true) {
      const monthStr = `${currentYear}-${pad(currentMonth)}`;
      const days = getDaysInMonth(currentYear, currentMonth);

      // Base signups per month: 10
      // Base renewals: 30
      // Churn events: 2 typically, but step change in Dec 2025 (e.g. 15 churns)
      let numSignups = 10;
      let numChurns = 2;

      if (currentYear === 2025 && currentMonth === 12) {
        numChurns = 15; // Spike in churn!
      }

      // Generate Signup Events
      for (let s = 0; s < numSignups; s++) {
        const d = Math.floor(random() * days) + 1;
        const cust = snapshot.customers[Math.floor(random() * snapshot.customers.length)]!;
        snapshot.subscription_events.push({
          id: `sub_${eventIdSeq++}`,
          customerId: cust.id,
          type: "signup",
          monthlyValue: 99,
          eventDate: `${currentYear}-${pad(currentMonth)}-${pad(d)}`,
        });
      }

      // Generate Churn Events
      for (let c = 0; c < numChurns; c++) {
        const d = Math.floor(random() * days) + 1;
        const cust = snapshot.customers[Math.floor(random() * snapshot.customers.length)]!;
        snapshot.subscription_events.push({
          id: `sub_${eventIdSeq++}`,
          customerId: cust.id,
          type: "churn",
          monthlyValue: 99,
          eventDate: `${currentYear}-${pad(currentMonth)}-${pad(d)}`,
        });
      }

      // Add standard renewals
      for (let r = 0; r < 30; r++) {
        const d = Math.floor(random() * days) + 1;
        const cust = snapshot.customers[Math.floor(random() * snapshot.customers.length)]!;
        snapshot.subscription_events.push({
          id: `sub_${eventIdSeq++}`,
          customerId: cust.id,
          type: "renew",
          monthlyValue: 99,
          eventDate: `${currentYear}-${pad(currentMonth)}-${pad(d)}`,
        });
      }

      // Hosting & Salary Expenses
      snapshot.expenses.push(
        {
          id: `exp_${monthStr}_hosting`,
          category: "hosting",
          amount: 1200,
          currency: "USD",
          expenseDate: `${monthStr}-15`,
          description: "AWS Cloud Infrastructure",
        },
      );

      if (currentYear === endYear && currentMonth === endMonth) break;
      currentMonth++;
      if (currentMonth > 12) {
        currentMonth = 1;
        currentYear++;
      }
    }
  } else {
    // Services Client / Xero Professional Services
    for (let i = 1; i <= 10; i++) {
      snapshot.customers.push({
        id: `c_${i}`,
        name: `Corporate Client ${i}`,
        cohortMonth: "2025-01",
      });
    }

    let invoiceSeq = 1;
    currentYear = startYear;
    currentMonth = startMonth;

    while (true) {
      const monthStr = `${currentYear}-${pad(currentMonth)}`;
      
      // Each client is billed $1500 monthly
      for (let i = 0; i < snapshot.customers.length; i++) {
        const customer = snapshot.customers[i]!;
        const invoiceId = `inv_${invoiceSeq++}`;
        const invoiceDate = `${monthStr}-05`;
        const dueDate = `${monthStr}-20`;

        snapshot.invoices.push({
          id: invoiceId,
          customerId: customer.id,
          amount: 1500,
          currency: "USD",
          invoiceDate,
          dueDate,
          status: "paid",
        });

        // Anchor client c_1 pays very late in March 2026
        const isAnchorLate = customer.id === "c_1" && currentYear === 2026 && currentMonth === 3;
        
        let paymentDate = `${monthStr}-12`; // Normally paid within 7 days
        if (isAnchorLate) {
          // Late payment: paid 3 months later (June 2026)
          paymentDate = `2026-06-12`;
        }

        snapshot.payments.push({
          id: `pmt_${invoiceId}`,
          invoiceId,
          amount: 1500,
          currency: "USD",
          paymentDate,
          status: "success",
        });
      }

      snapshot.expenses.push({
        id: `exp_${monthStr}_payroll`,
        category: "payroll",
        amount: 8000,
        currency: "USD",
        expenseDate: `${monthStr}-25`,
        description: "Staff Salaries",
      });

      if (currentYear === endYear && currentMonth === endMonth) break;
      currentMonth++;
      if (currentMonth > 12) {
        currentMonth = 1;
        currentYear++;
      }
    }
  }

  return snapshot;
}
