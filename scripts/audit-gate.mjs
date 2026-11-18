// CI dependency gate. Fails on high/critical advisories that have a
// non-breaking fix (npm audit fix would resolve them), so new issues cannot
// land unnoticed. Advisories whose only "fix" is a major change (often a
// downgrade npm suggests when no patched release exists) are printed as
// warnings for a human decision instead of permanently breaking CI.
import { execFileSync } from "node:child_process";

const omitDev = process.argv.includes("--omit=dev");
// --strict: every high/critical advisory blocks, fixable or not. Used for the
// production tree, which must stay clean; dev-only tooling uses the default.
const strict = process.argv.includes("--strict");
const args = ["audit", "--json", ...(omitDev ? ["--omit=dev"] : [])];
let raw;
try {
  raw = execFileSync("npm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
  raw = error.stdout;
}
if (!raw) {
  console.error("audit-gate: npm audit produced no output (registry unreachable?). Failing closed.");
  process.exit(2);
}
const report = JSON.parse(raw);
if (report.error) {
  console.error(`audit-gate: npm audit error: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(2);
}

const blocking = [];
const warnings = [];
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (vuln.severity !== "high" && vuln.severity !== "critical") continue;
  const fix = vuln.fixAvailable;
  const fixable = strict || fix === true || (typeof fix === "object" && fix && !fix.isSemVerMajor);
  const titles = (vuln.via ?? []).filter((v) => typeof v === "object").map((v) => v.title);
  // Entries whose "via" lists only other package names inherit the advisory
  // from a dependency; that dependency's own entry is the one to judge.
  if (titles.length === 0) continue;
  const line = `${vuln.severity.toUpperCase()} ${name} ${vuln.range} - ${titles[0]}`;
  (fixable ? blocking : warnings).push(line);
}

for (const line of warnings) console.log(`warn (no non-breaking fix): ${line}`);
if (blocking.length) {
  for (const line of blocking) console.error(`BLOCKING (fix available): ${line}`);
  console.error(`audit-gate: ${blocking.length} high/critical advisories have non-breaking fixes. Run npm audit fix or bump the pinned version.`);
  process.exit(1);
}
console.log(`audit-gate: ok (${warnings.length} unfixable high/critical advisories reported above).`);
