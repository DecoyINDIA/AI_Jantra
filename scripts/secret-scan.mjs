// Dependency-free secret scan over git-tracked files. High-signal patterns
// only, so CI noise stays near zero; it complements (not replaces) GitHub
// secret scanning. Mark a deliberate test fixture with "secret-scan:allow" on
// the same line.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{30,}/],
  ["OpenAI-style key", /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{40,}/],
  ["OpenRouter key", /\bsk-or-v1-[a-f0-9]{48,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
  ["Stripe live key", /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/],
  ["Cloudflare API token", /\bCLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{40}\b/],
];
// Only a marker followed by real base64 key material counts; bare marker
// strings appear legitimately in sanitizer tests and docs.
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n\s*[A-Za-z0-9+/=]{40,}/;
const SKIP = [/^package-lock\.json$/, /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf|zip|gz)$/i];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((file) => file && !SKIP.some((re) => re.test(file)));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line.includes("secret-scan:allow")) return;
    for (const [label, re] of PATTERNS) {
      if (re.test(line)) findings.push(`${file}:${index + 1}: ${label}`);
    }
  });
  const pk = PRIVATE_KEY.exec(text);
  if (pk) {
    const line = text.slice(0, pk.index).split("\n").length;
    if (!lines[line - 1]?.includes("secret-scan:allow")) findings.push(`${file}:${line}: private key material`);
  }
}

if (findings.length) {
  // Never print the matched value itself; CI logs are widely readable.
  for (const finding of findings) console.error(`secret-scan: ${finding}`);
  console.error(`secret-scan: ${findings.length} potential secret(s). Rotate any real credential, then remove it from history.`);
  process.exit(1);
}
console.log(`secret-scan: ok (${files.length} tracked files scanned).`);
