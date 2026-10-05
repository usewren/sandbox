// wren.js web components in a real page served from a public WREN tree
// (/orgs/{slug}/tree/web/…), so the API base is auto-detected from the URL.
// Covers every component, attribute, template feature, slot and event documented in
// the "wren.js — Client-side data binding" section of llms-full.txt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { BASE, setupData, hostPage, html, launch, texts, waitLoads } from "./lib/harness.mjs";

// Most pages load wren.js with defer; the documented plain <script> before the
// components is covered by its own test below
const DEFER = { script: `<script src="/wren.js" defer></script>` };

let ctx, data;
before(async () => {
  [ctx, data] = await Promise.all([launch(), setupData("components")]);
});
after(async () => { await ctx.close(); });

let n = 0;
async function open(body, opts = DEFER) {
  const url = await hostPage(data, `page-${++n}.html`, html(body, opts));
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}
const sorted = a => [...a].sort();
const loads = page => page.evaluate(() => window.__loads);

test("wren-list: all documents, template fields, dot paths, escaping and raw HTML, wren-load", async () => {
  const page = await open(`
    <wren-list data-test="all" collection="events">
      <template><div class="ev">{{name}}|{{city}}|{{venue.name}}|{{note}}|{{ version }}|{{missing.deep}}|<span class="raw">{{{note}}}</span></div></template>
    </wren-list>`);
  await waitLoads(page, ["all"]);
  const rows = await texts(page, "[data-test=all] .ev");
  assert.deepEqual(sorted(rows), sorted([
    "Spring Cup (moved)|Bern|Hall A|<b>bold</b>|2||bold",
    "Summer Open|Basel|Arena|<i>it</i>|1||it",
    "Autumn Trophy|Lyon|Dome|plain|1||plain",
  ]));
  // {{field}} is escaped, {{{field}}} is inserted as HTML
  assert.equal(await page.$$eval("[data-test=all] .raw b", b => b.length), 1);
  assert.equal(await page.$$eval("[data-test=all] .raw i", b => b.length), 1);
  // The template stays in place; output goes into a display:contents container
  assert.ok(await page.$("[data-test=all] > template"));
  // wren-load carries the raw API response; the element keeps it as _data
  const [ev] = await loads(page);
  assert.equal(ev.tag, "wren-list");
  assert.equal(ev.detail.collection, "events");
  assert.equal(ev.detail.items.length, 3);
  assert.equal(await page.$eval("[data-test=all]", el => el._data.items.length), 3);
  assert.deepEqual(page.errors, []);
});

test("wren-list: select, limit, offset, where, label", async () => {
  const page = await open(`
    <wren-list data-test="proj" collection="events" select="name,city" limit="2"><template><p>{{name}}/{{city}}/{{country}}</p></template></wren-list>
    <wren-list data-test="rest" collection="events" limit="2" offset="2"><template><p>{{name}}</p></template></wren-list>
    <wren-list data-test="where" collection="events" where="country:FR"><template><p>{{name}}</p></template></wren-list>
    <wren-list data-test="label" collection="events" label="published"><template><p>{{name}} v{{version}}</p></template></wren-list>`);
  await waitLoads(page, ["proj", "rest", "where", "label"]);
  const proj = await texts(page, "[data-test=proj] p");
  assert.equal(proj.length, 2);
  assert.ok(proj.every(p => /^[^/]+\/(Bern|Basel|Lyon)\/$/.test(p)), `country not selected: ${proj}`);
  const rest = await texts(page, "[data-test=rest] p");
  assert.equal(rest.length, 1);
  assert.deepEqual(sorted([...proj.map(p => p.split("/")[0]), ...rest]), sorted(["Spring Cup (moved)", "Summer Open", "Autumn Trophy"]));
  assert.deepEqual(await texts(page, "[data-test=where] p"), ["Autumn Trophy"]);
  assert.deepEqual(await texts(page, "[data-test=label] p"), ["Spring Cup v1"]);
  // The request carried the attributes as query parameters
  const urls = (await loads(page)).map(l => l.id);
  assert.deepEqual(sorted(urls), ["label", "proj", "rest", "where"]);
});

test("wren-list inside a table inserts <tr> rows after a marker and hides itself", async () => {
  const page = await open(`
    <table><thead><tr><th>Event</th></tr></thead><tbody id="tb"></tbody></table>
    <script>
      const l = document.createElement("wren-list");
      l.setAttribute("collection", "events");
      l.setAttribute("where", "country:CH");
      l.setAttribute("data-test", "rows");
      l.innerHTML = "<template><tr class='r'><td>{{name}}</td><td>{{city}}</td></tr></template>";
      document.getElementById("tb").appendChild(l);
    </script>`);
  await waitLoads(page, ["rows"]);
  const rows = await page.$$eval("#tb > tr.r", trs => trs.map(t => [...t.cells].map(c => c.textContent)));
  assert.deepEqual(sorted(rows.map(r => r.join("/"))), ["Spring Cup (moved)/Bern", "Summer Open/Basel"]);
  assert.equal(await page.$eval("#tb > wren-list", el => el.style.display), "none");
  assert.equal(await page.$eval("#tb", tb => [...tb.childNodes].filter(n => n.nodeType === 8 && n.data === "wren").length), 1);
});

test("wren-query: simple projection with select, where, label, limit", async () => {
  const page = await open(`
    <wren-query data-test="sel" collection="events" select="name,country" where="country:CH" limit="5"><template><p>{{name}} ({{country}}) {{city}}</p></template></wren-query>
    <wren-query data-test="lim" collection="events" limit="1"><template><p>{{name}}</p></template></wren-query>
    <wren-query data-test="lab" collection="events" label="published"><template><p>{{name}}</p></template></wren-query>`);
  await waitLoads(page, ["sel", "lim", "lab"]);
  assert.deepEqual(sorted(await texts(page, "[data-test=sel] p")), ["Spring Cup (moved) (CH)", "Summer Open (CH)"]);
  assert.equal((await texts(page, "[data-test=lim] p")).length, 1);
  assert.deepEqual(await texts(page, "[data-test=lab] p"), ["Spring Cup"]);
});

test("wren-query: aggregation with q (rows, group key fields flattened)", async () => {
  const page = await open(`
    <wren-query data-test="agg" collection="events"
      q='{"aggregate":{"groupBy":["country"],"metrics":{"n":{"count":"name"}}}}'>
      <template><div class="row">{{country}}: {{n}}</div></template>
    </wren-query>
    <wren-query data-test="qsel" collection="events" q='{"select":["name"],"where":"country:FR"}'>
      <template><div class="q">{{name}}</div></template>
    </wren-query>`);
  await waitLoads(page, ["agg", "qsel"]);
  assert.deepEqual(sorted(await texts(page, "[data-test=agg] .row")), ["CH: 2", "FR: 1"]);
  assert.deepEqual(await texts(page, "[data-test=qsel] .q"), ["Autumn Trophy"]);
  const agg = (await loads(page)).find(l => l.id === "agg");
  assert.ok(Array.isArray(agg.detail.rows));
});

test("wren-query: the label attribute applies with q too (sent inside the query); invalid q", async () => {
  const page = await open(`
    <wren-query data-test="ql" collection="events" q='{"select":["name"]}' label="published"><template><p>{{name}}</p></template></wren-query>
    <wren-query data-test="bad" collection="events" q='{nope' label="published"><template><p>{{name}}</p></template></wren-query>`);
  await waitLoads(page, ["ql"]);
  assert.deepEqual(await texts(page, "[data-test=ql] p"), ["Spring Cup"]);
  // With a label, q is parsed to add it: a broken q is reported, not sent
  assert.match(await page.$eval("[data-test=bad]", e => e.textContent.trim()), /^Error: Invalid q attribute: /);
});

test("wren-query: non-Latin-1 text in q is sent as UTF-8", async () => {
  const page = await open(`
    <wren-query data-test="uni" collection="events" q='{"select":["name"],"where":"city:東京"}'>
      <template><p>{{name}}</p></template><div slot="empty">No events</div><div slot="error">Failed</div>
    </wren-query>`);
  await page.waitForFunction(() => document.querySelector("[data-test=uni] [slot=empty]")?.style.display === "");
  assert.deepEqual(page.errors, []);
  assert.equal(await page.$eval("[data-test=uni] [slot=empty]", s => s.style.display), "");
});

test("wren-materialized: projection items and aggregate rows", async () => {
  const page = await open(`
    <wren-materialized data-test="ov" collection="events" name="overview"><template><div class="m">{{name}} — {{date}}</div></template></wren-materialized>
    <wren-materialized data-test="bc" collection="events" name="by-country"><template><div class="m">{{country}}={{n}}</div></template></wren-materialized>`);
  await waitLoads(page, ["ov", "bc"]);
  assert.deepEqual(sorted(await texts(page, "[data-test=ov] .m")), sorted(["Spring Cup (moved) — 2026-04-01", "Summer Open — 2026-07-01", "Autumn Trophy — 2026-10-01"]));
  assert.deepEqual(sorted(await texts(page, "[data-test=bc] .m")), ["CH=2", "FR=1"]);
  const ov = (await loads(page)).find(l => l.id === "ov");
  assert.equal(ov.detail.name, "overview");
});

test("wren-doc: by id, by natural key, with label; html in fields", async () => {
  const page = await open(`
    <wren-doc data-test="byid" collection="events" id="${data.events[1].id}"><template><h2>{{name}}</h2><p>{{venue.name}} v{{version}}</p></template></wren-doc>
    <wren-doc data-test="bykey" collection="articles" key="hello-world"><template><h1>{{title}}</h1><p class="b">{{{body}}}</p></template></wren-doc>
    <wren-doc data-test="keylabel" collection="articles" key="hello-world" label="published"><template><h1>{{title}}</h1><p class="b">{{{body}}}</p></template></wren-doc>
    <wren-doc data-test="idlabel" collection="events" id="${data.events[0].id}" label="published"><template><h1>{{name}}</h1></template></wren-doc>`);
  await waitLoads(page, ["byid", "bykey", "keylabel", "idlabel"]);
  assert.equal(await page.$eval("[data-test=byid] h2", e => e.textContent), "Summer Open");
  assert.equal(await page.$eval("[data-test=byid] p", e => e.textContent), "Arena v1");
  assert.equal(await page.$eval("[data-test=bykey] h1", e => e.textContent), "Hello again");
  assert.equal(await page.$eval("[data-test=keylabel] h1", e => e.textContent), "Hello");
  assert.equal(await page.$eval("[data-test=keylabel] .b em", e => e.textContent), "version");
  assert.equal(await page.$eval("[data-test=idlabel] h1", e => e.textContent), "Spring Cup");
  const byid = (await loads(page)).find(l => l.id === "byid");
  assert.equal(byid.detail.id, data.events[1].id);
});

test("wren-tree: every node with path and document fields; label", async () => {
  const page = await open(`
    <wren-tree data-test="site" tree="site"><template><li>{{path}}: {{name}}{{title}} [{{collection}}]</li></template></wren-tree>
    <wren-tree data-test="live" tree="site" label="live"><template><li>{{path}}: {{title}}</li></template></wren-tree>`);
  await waitLoads(page, ["site", "live"]);
  assert.deepEqual(sorted(await texts(page, "[data-test=site] li")), ["/about: Hello again [articles]", "/home: Spring Cup (moved) [events]"]);
  // Only the article carries the "live" label; nodes without it have no document
  const live = await texts(page, "[data-test=live] li");
  assert.ok(live.includes("/about: Hello again"), live.join());
  const site = (await loads(page)).find(l => l.id === "site");
  assert.equal(site.detail.nodes.length, 2);
});

test("slots: loading (custom and default), empty, error with {{error}}", async () => {
  const url = await hostPage(data, "slots.html", html(`
    <wren-list data-test="load" collection="events"><template><p>{{name}}</p></template><div slot="loading" class="spin">Fetching…</div></wren-list>
    <wren-list data-test="plain" collection="events"><template><p>{{name}}</p></template></wren-list>
    <wren-list data-test="empty" collection="empty"><template><p>{{name}}</p></template><div slot="empty">Nothing here</div><div slot="error">Err</div></wren-list>
    <wren-list data-test="empty2" collection="empty"><template><p>{{name}}</p></template></wren-list>
    <wren-list data-test="err" collection="secret"><template><p>{{name}}</p></template><div slot="error" class="e">Could not load: {{error}}</div></wren-list>
    <wren-list data-test="err2" collection="secret"><template><p>{{name}}</p></template></wren-list>`, DEFER));
  const page = await ctx.newPage();
  // Hold the events requests so the loading state can be seen
  await page.setRequestInterception(true);
  const held = [];
  page.on("request", req => {
    if (req.url().includes("/api/v1/orgs/") && new URL(req.url()).pathname.endsWith("/events")) held.push(req);
    else req.continue();
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("[data-test=load] .spin")?.style.display === "");
  assert.equal(await page.$eval("[data-test=plain]", e => e.textContent.trim()), "Loading…");
  await page.waitForFunction(() => window.__loads.length >= 0 && document.querySelector("[data-test=err] .e")?.style.display === "");
  await page.waitForFunction(n => n === 2, {}, held.length).catch(() => {});
  for (const r of held) await r.continue();
  await page.waitForFunction(() => document.querySelectorAll("[data-test=load] p").length === 3);
  assert.equal(await page.$eval("[data-test=load] .spin", e => e.style.display), "none");
  assert.equal((await texts(page, "[data-test=plain] p")).length, 3);

  // Empty: the empty slot shows (the error slot stays hidden)
  await page.waitForFunction(() => document.querySelector("[data-test=empty] [slot=empty]")?.style.display === "");
  assert.equal(await page.$eval("[data-test=empty] [slot=error]", e => e.style.display), "none");
  assert.equal((await texts(page, "[data-test=empty2] p")).length, 0);

  // Error: slot with {{error}} replaced, or the default red message
  assert.match(await page.$eval("[data-test=err] .e", e => e.textContent), /^Could not load: WREN fetch failed: 403/);
  await page.waitForFunction(() => /^Error: WREN fetch failed: 403/.test(document.querySelector("[data-test=err2]")?.textContent.trim()));
  // Failed loads don't fire wren-load
  assert.ok(!(await loads(page)).some(l => l.id === "err" || l.id === "err2"));
});

test("missing required attributes show an error", async () => {
  const page = await open(`
    <wren-list data-test="l"><template>x</template></wren-list>
    <wren-query data-test="q"><template>x</template></wren-query>
    <wren-materialized data-test="m1" name="overview"><template>x</template></wren-materialized>
    <wren-materialized data-test="m2" collection="events"><template>x</template></wren-materialized>
    <wren-doc data-test="d1" id="x"><template>x</template></wren-doc>
    <wren-doc data-test="d2" collection="events"><template>x</template></wren-doc>
    <wren-tree data-test="t"><template>x</template></wren-tree>
    <wren-materialized data-test="m404" collection="events" name="nope"><template>x</template></wren-materialized>
    <wren-doc data-test="d404" collection="articles" key="no-such-key"><template>x</template></wren-doc>
    <wren-tree data-test="t404" tree="no-such-tree"><div slot="error">{{error}}</div></wren-tree>
    <wren-query data-test="q403" collection="secret"><template>x</template></wren-query>`);
  const msg = sel => page.$eval(`[data-test=${sel}]`, e => e.textContent.trim());
  await page.waitForFunction(() => document.querySelector("[data-test=t404] [slot=error]")?.style.display === "");
  await page.waitForFunction(() => ["m404", "d404", "q403"].every(t => document.querySelector(`[data-test=${t}]`).textContent.includes("Error:")));
  assert.equal(await msg("l"), "Error: collection attribute required");
  assert.equal(await msg("q"), "Error: collection attribute required");
  assert.equal(await msg("m1"), "Error: collection and name attributes required");
  assert.equal(await msg("m2"), "Error: collection and name attributes required");
  assert.equal(await msg("d1"), "Error: collection attribute required");
  assert.equal(await msg("d2"), "Error: id or key attribute required");
  assert.equal(await msg("t"), "Error: tree attribute required");
  assert.match(await msg("m404"), /^Error: WREN fetch failed: 404/);
  assert.match(await msg("d404"), /^Error: WREN fetch failed: 404/);
  assert.match(await msg("q403"), /^Error: WREN fetch failed: 403/);
  // a tree that doesn't exist is simply not public → 403, shown in the error slot
  assert.match(await page.$eval("[data-test=t404] [slot=error]", e => e.textContent), /^WREN fetch failed: 403/);
});

test("window.Wren: version, renderTemplate, resolveBase, fetch", async () => {
  const page = await open(`<wren-list id="probe" data-test="p" collection="events" data-base="https://example.test/api/v1/orgs/x/"><template>x</template></wren-list>`);
  await page.waitForFunction(() => window.Wren);
  const r = await page.evaluate(async slug => {
    const W = window.Wren;
    const out = {};
    out.version = W.version;
    out.tmpl = W.renderTemplate("{{a.b.c}}|{{ x }}|{{{h}}}|{{h}}|{{nope}}|{{a.nope.deep}}|{{zero}}|{{f}}", { a: { b: { c: 1 } }, x: "y", h: "<b>&</b>", zero: 0, f: false });
    out.elBase = W.resolveBase(document.getElementById("probe"));
    out.pageBase = W.resolveBase(document.createElement("div"));
    out.nullBase = W.resolveBase(null);
    const res = await W.fetch(`/api/v1/orgs/${slug}/events?limit=1`);
    out.fetched = res.items.length;
    try { await W.fetch(`/api/v1/orgs/${slug}/secret`); } catch (e) { out.err = e.message; }
    return out;
  }, data.slug);
  assert.equal(r.version, "0.1.0");
  assert.equal(r.tmpl, "1|y|<b>&</b>|&lt;b&gt;&amp;&lt;/b&gt;|||0|false");
  assert.equal(r.elBase, "https://example.test/api/v1/orgs/x");
  assert.equal(r.pageBase, `${BASE}/api/v1/orgs/${data.slug}`);
  assert.equal(r.nullBase, `${BASE}/api/v1/orgs/${data.slug}`);
  assert.equal(r.fetched, 1);
  assert.match(r.err, /^WREN fetch failed: 403/);
});

test("documented usage: a plain <script src=\"/wren.js\"> before the components", async () => {
  // The elements are upgraded before the parser has added their <template> and slots;
  // wren.js waits for the document to be parsed before reading them
  const page = await open(`
    <wren-list data-test="doc" collection="events" select="name,city" limit="20">
      <template><div class="ev">{{name}} — {{city}}</div></template>
      <div slot="empty">No events</div>
    </wren-list>`, { script: `<script src="/wren.js"></script>` });
  await waitLoads(page, ["doc"]);
  assert.equal((await texts(page, "[data-test=doc] .ev")).length, 3);
  assert.equal(await page.$eval("[data-test=doc] [slot=empty]", s => s.style.display), "none");
});

test("wren-doc hides its loading slot after loading", async () => {
  const page = await open(`
    <wren-doc data-test="d" collection="articles" key="hello-world"><template><h1>{{title}}</h1></template><span slot="loading">Loading article…</span></wren-doc>`);
  await waitLoads(page, ["d"]);
  await page.waitForSelector("[data-test=d] h1");
  assert.equal(await page.$eval("[data-test=d] [slot=loading]", s => s.style.display), "none");
});

test("components without <template> show each item's data as JSON", async () => {
  const page = await open(`
    <wren-list data-test="nt" collection="events" where="country:FR"></wren-list>
    <wren-query data-test="nq" collection="events" q='{"aggregate":{"groupBy":["country"],"metrics":{"n":{"count":"name"}}}}'></wren-query>
    <wren-doc data-test="nd" collection="articles" key="hello-world"></wren-doc>`);
  await waitLoads(page, ["nt", "nq", "nd"]);
  const json = sel => page.$$eval(`[data-test=${sel}] pre`, ps => ps.map(p => JSON.parse(p.textContent)));
  const [fr] = await json("nt");
  assert.equal(fr.name, "Autumn Trophy");
  assert.equal(fr.city, "Lyon");
  // Aggregate rows have no data: the whole row is shown
  assert.deepEqual((await json("nq")).map(r => r.n).sort(), [1, 2]);
  assert.equal((await json("nd"))[0].title, "Hello again");
});

test("\"Loading…\" is removed when the result is empty or an error slot is shown", async () => {
  const page = await open(`
    <wren-list data-test="e1" collection="empty"><template><p>{{name}}</p></template></wren-list>
    <wren-list data-test="e2" collection="empty"><template><p>{{name}}</p></template><div slot="empty">Nothing here</div></wren-list>
    <wren-list data-test="e3" collection="secret"><template><p>{{name}}</p></template><div slot="error">Could not load</div></wren-list>`);
  await waitLoads(page, ["e1", "e2"]);
  await page.waitForFunction(() => document.querySelector("[data-test=e3] [slot=error]").style.display === "");
  assert.equal(await page.$eval("[data-test=e1]", e => e.innerText.trim()), "");
  assert.equal(await page.$eval("[data-test=e2]", e => e.innerText.trim()), "Nothing here");
  assert.equal(await page.$eval("[data-test=e3]", e => e.innerText.trim()), "Could not load");
});
