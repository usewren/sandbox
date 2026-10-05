// Shared helpers for the wren.js browser tests: accounts and public test data via the
// API, fixture pages (hosted in a public WREN tree, or on a small local server on
// another origin), headless Chrome with JS coverage of wren.js.
//
// Environment:
//   WREN_URL      server under test (default http://localhost:4801) — never a live instance
//   CHROME_PATH   Chrome/Chromium executable (default: the usual install location)
//   COVERAGE_DIR  where per-file coverage JSON is written (default tests/browser/coverage/raw)
//   SCREENSHOT_DIR where bug screenshots go (default tests/browser/coverage/screenshots)
import puppeteer from "puppeteer-core";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Coverage } from "./coverage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASE = (process.env.WREN_URL ?? "http://localhost:4801").replace(/\/$/, "");
export const COVERAGE_DIR = process.env.COVERAGE_DIR ?? join(HERE, "..", "coverage", "raw");
export const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR ?? join(HERE, "..", "coverage", "screenshots");

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find(p => existsSync(p)) ?? candidates[0];
}

export function uniq(prefix = "t") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function request(method, path, { cookie, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
  return json;
}

/** Sign up a fresh account; returns { email, cookie, userId, slug, api(method, path, body) }. */
export async function account(label = "user") {
  const email = `${uniq(label)}@e2e.test`;
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email, password: "secret-pass-123", name: `${label} tester` }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const me = await request("GET", "/api/v1/me", { cookie });
  return { email, cookie, userId: me.user.id, slug: me.org.slug, api: (m, p, b) => request(m, p, { cookie, body: b }) };
}

export async function uploadAsset(acct, collection, filename, content, type) {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), filename);
  const res = await fetch(`${BASE}/api/v1/${collection}`, { method: "POST", headers: { Cookie: acct.cookie, Origin: BASE }, body: form });
  if (!res.ok) throw new Error(`upload ${filename} → ${res.status} ${await res.text()}`);
  return res.json();
}

/** Poll until fn() resolves to a truthy value (for server-side async work). */
export async function eventually(fn, timeout = 10000) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - start > timeout) throw new Error("eventually: timed out");
    await new Promise(r => setTimeout(r, 100));
  }
}

/**
 * Public test data for wren.js: an org whose collections/trees are readable by anyone.
 *   events    3 docs (labels: "published" on the first, at v1), public
 *   articles  natural key "slug", public; "hello-world" has published v1 + current v2
 *   empty     public, no documents
 *   secret    one document, NOT public
 *   tree site /home → event 1, /about → article; public
 *   materialized: events/overview (projection), events/by-country (aggregate)
 *   tree web  hosts the fixture HTML pages (binary collection "web"), public
 */
export async function setupData(label = "wrenjs") {
  const acct = await account(label);
  const { api } = acct;
  const events = [];
  for (const e of [
    { name: "Spring Cup", city: "Bern", country: "CH", date: "2026-04-01", venue: { name: "Hall A" }, note: "<b>bold</b>" },
    { name: "Summer Open", city: "Basel", country: "CH", date: "2026-07-01", venue: { name: "Arena" }, note: "<i>it</i>" },
    { name: "Autumn Trophy", city: "Lyon", country: "FR", date: "2026-10-01", venue: { name: "Dome" }, note: "plain" },
  ]) events.push(await api("POST", "/api/v1/events", e));
  await api("POST", `/api/v1/events/${events[0].id}/labels`, { label: "published" });
  await api("PUT", `/api/v1/events/${events[0].id}`, { ...events[0].data, name: "Spring Cup (moved)" });

  await api("PUT", "/api/v1/articles/_schema", { collectionType: "json", schema: { type: "object" }, naturalKey: "slug" });
  const article = await api("POST", "/api/v1/articles", { slug: "hello-world", title: "Hello", body: "First <em>version</em>" });
  await api("POST", `/api/v1/articles/${article.id}/labels`, { label: "published" });
  await api("PUT", `/api/v1/articles/${article.id}`, { slug: "hello-world", title: "Hello again", body: "Second version" });

  await api("PUT", "/api/v1/empty/_schema", { collectionType: "json", schema: { type: "object" } });
  await api("POST", "/api/v1/secret", { name: "hidden" });

  await api("PUT", "/api/v1/tree/site/home", { documentId: events[0].id });
  await api("PUT", "/api/v1/tree/site/about", { documentId: article.id });
  await api("POST", `/api/v1/articles/${article.id}/labels`, { label: "live" });

  for (const r of ["collection:events", "collection:articles", "collection:empty", "tree:site", "tree:web"]) {
    await api("POST", "/api/v1/permissions", { principal: "*", resource: r, access: "read" });
  }
  await api("PUT", "/api/v1/web/_schema", { collectionType: "binary" });

  await api("PUT", "/api/v1/events/_materialized/overview", { query: { select: ["name", "date"] }, refreshOn: "write" });
  await api("PUT", "/api/v1/events/_materialized/by-country", { query: { aggregate: { groupBy: ["country"], metrics: { n: { count: "name" } } } }, refreshOn: "write" });
  for (const name of ["overview", "by-country"]) {
    await eventually(() => fetch(`${BASE}/api/v1/orgs/${acct.slug}/events/_materialized/${name}`).then(r => r.ok));
  }
  return { ...acct, events, article };
}

/** Host an HTML page in the org's public "web" tree; returns its public URL. */
export async function hostPage(acct, name, html) {
  const doc = await uploadAsset(acct, "web", name, html, "text/html");
  await acct.api("PUT", `/api/v1/tree/web/${name}`, { documentId: doc.id });
  return `${BASE}/orgs/${acct.slug}/tree/web/${name}`;
}

/**
 * A static server on another origin (127.0.0.1, random port). `pages` maps a path to
 * HTML; any other /api/…, /orgs/… or /wren.js request is proxied to the WREN server, so
 * pages that resolve their API base to this origin still reach WREN.
 */
export async function staticServer() {
  const pages = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (pages.has(url.pathname)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(pages.get(url.pathname));
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/orgs/") || url.pathname === "/wren.js") {
      const up = await fetch(BASE + req.url, { headers: { Accept: req.headers.accept ?? "*/*" } });
      res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") ?? "application/octet-stream" });
      return res.end(Buffer.from(await up.arrayBuffer()));
    }
    res.writeHead(404).end("not found");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    page(path, html) { pages.set(path, html); return origin + path; },
    close: () => new Promise(r => server.close(r)),
  };
}

/** A fixture page: wren.js plus a recorder for wren-load events. */
export function html(body, { script = `<script src="/wren.js"></script>` } = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>wren.js fixture</title>
<script>
  window.__loads = [];
  document.addEventListener("wren-load", e => window.__loads.push({ tag: e.target.tagName.toLowerCase(), id: e.target.getAttribute("data-test"), detail: e.detail }));
</script>
${script}
</head><body>
${body}
</body></html>`;
}

// ── Browser ───────────────────────────────────────────────────────────────────

/** Launch headless Chrome for one test file; pages record coverage of wren.js. */
export async function launch() {
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    defaultViewport: { width: 1100, height: 800 },
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const pages = [];
  async function newPage() {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.errors = [];
    page.on("pageerror", e => page.errors.push(e.message));
    page.jsCoverage = new Coverage(page, url => /\/wren\.js(\?|$)/.test(url), () => "/wren.js");
    await page.jsCoverage.start();
    pages.push(page);
    return page;
  }
  async function close() {
    const entries = [];
    for (const page of pages) entries.push(...(await page.jsCoverage.stop()));
    mkdirSync(COVERAGE_DIR, { recursive: true });
    writeFileSync(join(COVERAGE_DIR, `${randomUUID()}.json`), JSON.stringify(entries));
    await browser.close();
  }
  return { browser, newPage, close };
}

/** Normalized text of every element matching selector. */
export function texts(page, selector) {
  return page.$$eval(selector, els => els.map(e => e.textContent.replace(/\s+/g, " ").trim()));
}

/** Wait until n wren-load events have fired (or the given component ids loaded). */
export async function waitLoads(page, ids, timeout = 10000) {
  await page.waitForFunction(ids => ids.every(id => window.__loads.some(l => l.id === id)), { timeout }, ids);
}

export async function screenshot(page, name) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}
