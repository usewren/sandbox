// Merge the Chrome JS coverage written by each test file (see harness.mjs) and print
// a per-file used-bytes summary. Byte ranges are unioned across all pages and runs,
// so a function counts as used if any test executed it.
//
//   node lib/coverage-report.mjs [coverageDir]
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? process.env.COVERAGE_DIR ?? join(HERE, "..", "coverage", "raw");
if (!existsSync(dir)) { console.log(`No coverage data in ${dir}`); process.exit(0); }

// Key = path without origin/query (e.g. /admin/js/pages/trees.js); wren.js is served
// both at /wren.js and /orgs/{slug}/wren.js, which count as one file
const keyOf = url => {
  let path;
  try { path = new URL(url).pathname; } catch { path = url; }
  return path.endsWith("/wren.js") ? "/wren.js" : path;
};

const files = new Map(); // key → { text, used: Uint8Array }
for (const name of readdirSync(dir).filter(f => f.endsWith(".json"))) {
  for (const entry of JSON.parse(readFileSync(join(dir, name), "utf8"))) {
    const key = keyOf(entry.url);
    let f = files.get(key);
    if (!f || f.text.length !== entry.text.length) {
      if (f) console.warn(`warning: ${key} changed size between runs; keeping the newest`);
      f = { text: entry.text, used: new Uint8Array(entry.text.length) };
      files.set(key, f);
    }
    for (const r of entry.ranges) f.used.fill(1, r.start, r.end);
  }
}

const rows = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, f]) => {
  const used = f.used.reduce((n, b) => n + b, 0);
  return { file: key, used, total: f.text.length, pct: f.text.length ? (100 * used) / f.text.length : 0 };
});
const total = rows.reduce((a, r) => ({ used: a.used + r.used, total: a.total + r.total }), { used: 0, total: 0 });

const w = Math.max(10, ...rows.map(r => r.file.length));
console.log(`\nJS coverage (used bytes, Chrome V8 block coverage)\n${"file".padEnd(w)}  ${"used".padStart(7)}  ${"total".padStart(7)}  ${"%".padStart(6)}`);
for (const r of rows) console.log(`${r.file.padEnd(w)}  ${String(r.used).padStart(7)}  ${String(r.total).padStart(7)}  ${r.pct.toFixed(1).padStart(6)}`);
console.log(`${"TOTAL".padEnd(w)}  ${String(total.used).padStart(7)}  ${String(total.total).padStart(7)}  ${(total.total ? (100 * total.used) / total.total : 0).toFixed(1).padStart(6)}\n`);

// Optional: list unused line ranges per file (COVERAGE_UNUSED=1) to see what's left
if (process.env.COVERAGE_UNUSED) {
  for (const [key, f] of files) {
    const lines = f.text.split("\n");
    let pos = 0;
    const unused = [];
    lines.forEach((line, i) => {
      const s = pos, e = pos + line.length;
      pos = e + 1;
      if (line.trim() && f.used.subarray(s, e).every(b => b === 0)) unused.push(i + 1);
    });
    if (!unused.length) continue;
    const spans = [];
    for (const n of unused) {
      const last = spans[spans.length - 1];
      if (last && n === last[1] + 1) last[1] = n; else spans.push([n, n]);
    }
    console.log(`${key}: unused lines ${spans.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(", ")}`);
  }
}

writeFileSync(join(dir, "..", "summary.json"), JSON.stringify({ rows, total }, null, 2));
