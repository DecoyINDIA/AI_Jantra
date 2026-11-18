// Stage the compiled runtime (repo dist/) and the built web UI (web/dist)
// inside the desktop app directory before electron-builder runs.
// electron-builder only packs files under the app directory; globs such as
// ../dist/** are silently ignored, which previously produced an installer
// with no API runtime and no UI.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(desktop, "..");
const sources = [
  { from: join(repo, "dist"), to: join(desktop, "runtime"), check: "server/app.js", build: "npm run build" },
  { from: join(repo, "web", "dist"), to: join(desktop, "web", "dist"), check: "index.html", build: "npm run web:build" },
];

// Tests and source maps do not ship. runtime/evals stays: production stages
// import their rubrics from runtime/evals/rubrics.js.
const EXCLUDED = [/\.test\.js$/, /\.map$/];

for (const { from, to, check, build } of sources) {
  if (!existsSync(join(from, check))) {
    console.error(`stage: ${join(from, check)} is missing. Run \`${build}\` at the repo root first.`);
    process.exit(1);
  }
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src).split(sep).join("/");
      return !EXCLUDED.some((re) => re.test(rel));
    },
  });
  console.log(`stage: ${relative(repo, from)} -> ${relative(repo, to)}`);
}
