// Run every src/**/*.test.ts with node's test runner. Glob arguments to
// `node --test` need Node >= 21 and shell globs are not portable (Windows),
// so the file list is built here and passed explicitly.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith(".test.ts")) out.push(relative(process.cwd(), full));
  }
  return out;
}

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ["src"];
const files = roots.flatMap((root) => collect(root)).sort();
if (!files.length) {
  console.error(`run-tests: no *.test.ts files under ${roots.join(", ")}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
