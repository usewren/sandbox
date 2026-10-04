// How wren.js finds the API: data-base / data-org / data-origin on the <script> tag or
// on each component, the /orgs/{slug}/ page URL, the /orgs/{slug}/wren.js script URL,
// and the authenticated fallback. Pages are served from a small local server on
// another origin (127.0.0.1) unless noted, which proxies /api and /orgs to WREN.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, setupData, staticServer, html, launch, texts, waitLoads } from "./lib/harness.mjs";

let ctx, data, site;
before(async () => {
  [ctx, data, site] = await Promise.all([launch(), setupData("config"), staticServer()]);
});
after(async () => {
  await ctx.close();
  await site.close();
});

const LIST = (id, attrs = "") => `<wren-list data-test="${id}" collection="events" where="country:FR" ${attrs}><template><p class="n">{{name}}</p></template><div slot="error" class="err">{{error}}</div></wren-list>`;

let n = 0;
async function open(body, script, path) {
  const url = site.page(path ?? `/fixture-${++n}.html`, html(body, { script }));
  const page = await ctx.newPage();
  const requests = [];
  page.on("request", r => { if (/\/api\/v1\//.test(r.url())) requests.push(r.url()); });
  page.requests = requests;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}
const rendered = (page, id) => texts(page, `[data-test=${id}] .n`);

test("script src /orgs/{slug}/wren.js: org detected from the script URL (cross-origin)", async () => {
  const page = await open(LIST("a"), `<script src="${BASE}/orgs/${data.slug}/wren.js" defer></script>`);
  await waitLoads(page, ["a"]);
  assert.deepEqual(await rendered(page, "a"), ["Autumn Trophy"]);
  assert.ok(page.requests[0].startsWith(`${BASE}/api/v1/orgs/${data.slug}/events?`), page.requests[0]);
  assert.equal(await page.evaluate(() => window.Wren.resolveBase(null)), `${BASE}/api/v1/orgs/${data.slug}`);
});

test("data-org on the script tag: origin taken from the script URL", async () => {
  const page = await open(LIST("b"), `<script src="${BASE}/wren.js" data-org="${data.slug}" defer></script>`);
  await waitLoads(page, ["b"]);
  assert.deepEqual(await rendered(page, "b"), ["Autumn Trophy"]);
  assert.ok(page.requests[0].startsWith(`${BASE}/api/v1/orgs/${data.slug}/`), page.requests[0]);
});

test("data-org + data-origin on the script tag", async () => {
  // The page's own origin proxies to WREN, so pointing data-origin at it proves it's used
  const page = await open(LIST("c"), `<script src="${BASE}/wren.js" data-org="${data.slug}" data-origin="${site.origin}" defer></script>`);
  await waitLoads(page, ["c"]);
  assert.deepEqual(await rendered(page, "c"), ["Autumn Trophy"]);
  assert.ok(page.requests[0].startsWith(`${site.origin}/api/v1/orgs/${data.slug}/`), page.requests[0]);
});

test("data-base on the script tag (trailing slash removed)", async () => {
  const page = await open(LIST("d"), `<script src="${BASE}/wren.js" data-base="${BASE}/api/v1/orgs/${data.slug}/" defer></script>`);
  await waitLoads(page, ["d"]);
  assert.deepEqual(await rendered(page, "d"), ["Autumn Trophy"]);
  assert.ok(page.requests[0].startsWith(`${BASE}/api/v1/orgs/${data.slug}/events?`), page.requests[0]);
});

test("per-component data-base, data-org and data-origin override the script tag", async () => {
  // The script tag names an org that doesn't exist; components that bring their own
  // configuration still work, the one that inherits it gets the server's error
  const page = await open(`
    ${LIST("e1", `data-base="${site.origin}/api/v1/orgs/${data.slug}"`)}
    ${LIST("e2", `data-org="${data.slug}"`)}
    ${LIST("e3", `data-org="${data.slug}" data-origin="${site.origin}"`)}
    ${LIST("e4")}`,
  `<script src="${BASE}/wren.js" data-org="no-such-org-slug" defer></script>`);
  await waitLoads(page, ["e1", "e2", "e3"]);
  for (const id of ["e1", "e2", "e3"]) assert.deepEqual(await rendered(page, id), ["Autumn Trophy"], id);
  const bases = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("wren-list")].map(el => [el.dataset.test, window.Wren.resolveBase(el)])));
  assert.deepEqual(bases, {
    e1: `${site.origin}/api/v1/orgs/${data.slug}`,
    e2: `${BASE}/api/v1/orgs/${data.slug}`, // origin from the script URL
    e3: `${site.origin}/api/v1/orgs/${data.slug}`,
    e4: `${BASE}/api/v1/orgs/no-such-org-slug`,
  });
  await page.waitForFunction(() => document.querySelector("[data-test=e4] .err").style.display === "");
  assert.match(await page.$eval("[data-test=e4] .err", e => e.textContent), /^WREN fetch failed: 404/);

  // A script-level data-origin applies to components that only set data-org
  const page2 = await open(LIST("e5", `data-org="${data.slug}"`), `<script src="${BASE}/wren.js" data-origin="${site.origin}" defer></script>`);
  await waitLoads(page2, ["e5"]);
  assert.ok(page2.requests[0].startsWith(`${site.origin}/api/v1/orgs/${data.slug}/`), page2.requests[0]);
});

test("page under /orgs/{slug}/…: org from the page URL, origin = page origin or data-origin", async () => {
  const path = `/orgs/${data.slug}/pages/detect.html`;
  const page = await open(LIST("f"), `<script src="${BASE}/wren.js" defer></script>`, path);
  await waitLoads(page, ["f"]);
  assert.deepEqual(await rendered(page, "f"), ["Autumn Trophy"]);
  assert.ok(page.requests[0].startsWith(`${site.origin}/api/v1/orgs/${data.slug}/`), page.requests[0]);

  const path2 = `/orgs/${data.slug}/pages/detect-origin.html`;
  const page2 = await open(LIST("g"), `<script src="${BASE}/wren.js" data-origin="${BASE}" defer></script>`, path2);
  await waitLoads(page2, ["g"]);
  assert.ok(page2.requests[0].startsWith(`${BASE}/api/v1/orgs/${data.slug}/`), page2.requests[0]);
  // data-org on a page under /orgs/ uses the page origin
  const page3 = await open(LIST("h", `data-org="${data.slug}"`), `<script src="${BASE}/wren.js" defer></script>`, `/orgs/${data.slug}/pages/detect-org.html`);
  await waitLoads(page3, ["h"]);
  assert.ok(page3.requests[0].startsWith(`${site.origin}/api/v1/orgs/${data.slug}/`), page3.requests[0]);
});

test("no org anywhere: authenticated /api/v1 of the script's origin (anonymous → error)", async () => {
  const page = await open(LIST("i"), `<script src="${BASE}/wren.js" defer></script>`);
  await page.waitForFunction(() => document.querySelector("[data-test=i] .err").style.display === "");
  assert.ok(page.requests[0].startsWith(`${BASE}/api/v1/events?`), page.requests[0]);
  assert.equal(await page.evaluate(() => window.Wren.resolveBase(null)), `${BASE}/api/v1`);
});

test("module script (no document.currentScript): page origin is used", async () => {
  // Module scripts have no document.currentScript, so no script attributes or URL apply.
  // wren.js is loaded from the page's own origin (proxied), as modules need CORS.
  const page = await open(`
    ${LIST("j", `data-org="${data.slug}"`)}
    ${LIST("k")}`, `<script type="module" src="/wren.js"></script>`);
  await waitLoads(page, ["j"]);
  assert.deepEqual(await rendered(page, "j"), ["Autumn Trophy"]);
  assert.ok(page.requests.some(u => u.startsWith(`${site.origin}/api/v1/orgs/${data.slug}/`)), page.requests.join());
  // Without any org: same-origin authenticated API → 401 for an anonymous visitor
  await page.waitForFunction(() => document.querySelector("[data-test=k] .err").style.display === "");
  assert.match(await page.$eval("[data-test=k] .err", e => e.textContent), /^WREN fetch failed: 401/);
  assert.ok(page.requests.some(u => u.startsWith(`${site.origin}/api/v1/events?`)), page.requests.join());
});

test("same-origin page signed in to WREN can use the authenticated API", async () => {
  // A page on the WREN origin outside /orgs/ (here: the admin's origin, via a page in a
  // private tree opened with the session) uses /api/v1 with the session cookie.
  const page = await ctx.newPage();
  const [name, ...v] = data.cookie.split("; ")[0].split("=");
  await page.browserContext().setCookie({ name, value: v.join("="), url: BASE });
  await page.goto(`${BASE}/admin/`, { waitUntil: "domcontentloaded" });
  const r = await page.evaluate(async () => {
    await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "/wren.js"; s.onload = res; s.onerror = rej; document.head.append(s); });
    const el = document.createElement("wren-list");
    el.setAttribute("collection", "secret");
    el.innerHTML = "<template><p class='n'>{{name}}</p></template>";
    const loaded = new Promise(res => el.addEventListener("wren-load", e => res(e.detail.items.length)));
    document.body.append(el);
    return { base: window.Wren.resolveBase(el), count: await loaded, text: el.querySelector(".n")?.textContent };
  });
  assert.equal(r.base, `${BASE}/api/v1`);
  assert.equal(r.count, 1);
  assert.equal(r.text, "hidden");
});
