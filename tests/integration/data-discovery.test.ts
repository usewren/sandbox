import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, get, signUp, signIn } from "../setup";

const stamp = Date.now();
const email = `data-disco+${stamp}@wren.dev`;
const outsiderEmail = `data-disco-out+${stamp}@wren.dev`;
const pubCol = `catalog${stamp}`;
const privCol = `internal${stamp}`;
const tree = `www${stamp}`;
let cookie: string;
let outsider: string;
let slug: string;

beforeAll(async () => {
  await signUp(email, "secret123", "Disco Org");
  ({ cookie } = await signIn(email, "secret123"));
  await signUp(outsiderEmail, "secret123", "Outsider");
  ({ cookie: outsider } = await signIn(outsiderEmail, "secret123"));
  slug = (await (await get("/api/v1/me", cookie)).json()).org.slug;

  await fetch(`${BASE_URL}/api/v1/${pubCol}/_schema`, {
    method: "PUT",
    headers: { Origin: BASE_URL, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "object", properties: { name: { type: "string" }, kind: { type: "string", enum: ["a", "b"] }, price: {} } }),
  });
  const { id } = await (await post(`/api/v1/${pubCol}`, { name: "Widget", kind: "a", blurb: "x".repeat(300) }, cookie)).json();
  await post(`/api/v1/${pubCol}/${id}/labels`, { label: "published" }, cookie);
  await post(`/api/v1/${privCol}`, { title: "Hidden plan" }, cookie);

  // A browsable site: a tree with /index.html
  const form = new FormData();
  form.append("file", new File(["<p>home</p>"], "index.html", { type: "text/html" }));
  const file = await (await fetch(`${BASE_URL}/api/v1/site${stamp}`, { method: "POST", headers: { Origin: BASE_URL, Cookie: cookie }, body: form })).json();
  await fetch(`${BASE_URL}/api/v1/tree/${tree}/index.html`, {
    method: "PUT",
    headers: { Origin: BASE_URL, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ documentId: file.id }),
  });

  await post("/api/v1/permissions", { principal: "*", resource: `collection:${pubCol}`, access: "read" }, cookie);
  await post("/api/v1/permissions", { principal: "*", resource: `tree:${tree}`, access: "read" }, cookie);
});

describe("static discovery endpoints", () => {
  it("/health", async () => {
    const body = await (await fetch(`${BASE_URL}/health`)).json();
    expect(body.status).toBe("ok");
    expect(body.version).toBeTruthy();
  });

  it("/openapi.json is the API spec", async () => {
    const res = await fetch(`${BASE_URL}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths).length).toBeGreaterThan(5);
  });

  it("/docs is the HTML API reference", async () => {
    const res = await fetch(`${BASE_URL}/docs`);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toContain('data-url="/openapi.json"');
  });

  it("/wren.js and its per-org alias serve the client library", async () => {
    for (const path of ["/wren.js", `/orgs/${slug}/wren.js`]) {
      const res = await fetch(`${BASE_URL}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/javascript");
      expect((await res.text()).length).toBeGreaterThan(100);
    }
  });

  it("/robots.txt welcomes crawlers and points at the sitemap", async () => {
    const res = await fetch(`${BASE_URL}/robots.txt`);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("User-agent: ClaudeBot");
    expect(text).toMatch(/Sitemap: \S+\/sitemap\.xml/);
  });

  it("/sitemap.xml lists the public pages and guides", async () => {
    const res = await fetch(`${BASE_URL}/sitemap.xml`);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toStartWith('<?xml version="1.0"');
    for (const p of ["/docs", "/llms.txt", "/tutorial", "/guides"]) expect(xml).toContain(`${p}</loc>`);
  });

  it("/llms.txt and /llms-full.txt are plain text references", async () => {
    for (const path of ["/llms.txt", "/llms-full.txt"]) {
      const res = await fetch(`${BASE_URL}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(await res.text()).toContain("WREN");
    }
    expect((await (await fetch(`${BASE_URL}/llms-full.txt`)).text())).toContain("/api/v1/{collection}/_query");
  });

  it("unknown non-API paths are a JSON 404", async () => {
    const res = await fetch(`${BASE_URL}/no-such-page-${stamp}`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Not found");
  });

  it("CORS preflight is answered", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/projects`, { method: "OPTIONS", headers: { Origin: "https://example.com" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("GET /api/v1/projects", () => {
  it("lists orgs with public resources and their URLs, without auth", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/projects`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    const { projects } = await res.json();
    const mine = projects.find((p: any) => p.slug === slug);
    expect(mine.name).toBe("Disco Org");
    expect(mine.url).toEndWith(`/orgs/${slug}/llms.txt`);
    expect(mine.collections).toEqual([
      expect.objectContaining({ name: pubCol, access: "read", labelFilter: null, url: expect.stringContaining(`/api/v1/orgs/${slug}/${pubCol}`) }),
    ]);
    expect(mine.trees).toEqual([
      expect.objectContaining({ name: tree, entryUrl: expect.stringContaining(`/orgs/${slug}/tree/${tree}/index.html`) }),
    ]);
    // Private collections never show up
    expect(JSON.stringify(projects)).not.toContain(privCol);
  });
});

describe("org llms.txt", () => {
  it("anonymous: only public collections and trees, with samples and schema summary", async () => {
    for (const path of [`/orgs/${slug}/llms.txt`, `/api/v1/orgs/${slug}/llms.txt`]) {
      const res = await fetch(`${BASE_URL}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).not.toBe("private, no-store");
      const text = await res.text();
      expect(text).toContain("# Disco Org — Wren data context");
      expect(text).toContain("*Public data context.");
      expect(text).toContain(`### ${pubCol} (1 documents)`);
      expect(text).toContain("kind: string (enum: a|b)");
      expect(text).toContain("price: any");
      expect(text).toContain("Labels in use: published (1 docs)");
      expect(text).toContain('- "Widget" (v1, labels: published)');
      // Long sample data is truncated
      expect(text).toContain("…");
      expect(text).toContain(`### ${tree} (1 paths)`);
      expect(text).toContain("/index.html → ");
      expect(text).toContain(`Full authenticated context: `);
      expect(text).not.toContain(privCol);
      expect(text).not.toContain("Hidden plan");
    }
  });

  it("the tree section names the assigned document's collection, not _paths", async () => {
    // The query joins documents on the assignment doc, so every path reads "→ _paths/<id>"
    const text = await (await fetch(`${BASE_URL}/orgs/${slug}/llms.txt`)).text();
    expect(text).toContain(`/index.html → site${stamp}/`);
  });

  it("owner: every collection, marked authenticated and not cacheable", async () => {
    const res = await get(`/api/v1/orgs/${slug}/llms.txt`, cookie);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const text = await res.text();
    expect(text).toContain("*Authenticated data context.");
    expect(text).toContain(`### ${privCol} (1 documents)`);
    expect(text).toContain("Schema: schema-free");
    expect(text).toContain("Labels in use: none");
    expect(text).toContain("Hidden plan");
    expect(text).toContain("API key creation: POST");
  });

  it("a signed-in non-member gets the public view", async () => {
    const res = await get(`/orgs/${slug}/llms.txt`, outsider);
    const text = await res.text();
    expect(text).toContain(`### ${pubCol}`);
    expect(text).not.toContain(privCol);
    expect(text).toContain("*Authenticated data context.");
  });

  it("an org with no data says so", async () => {
    const outSlug = (await (await get("/api/v1/me", outsider)).json()).org.slug;
    const text = await (await fetch(`${BASE_URL}/orgs/${outSlug}/llms.txt`)).text();
    expect(text).toMatch(/No collections yet|No public collections/);
  });

  it("an unknown slug is a 404", async () => {
    expect((await fetch(`${BASE_URL}/orgs/no-such-org-${stamp}/llms.txt`)).status).toBe(404);
    expect((await fetch(`${BASE_URL}/api/v1/orgs/no-such-org-${stamp}/llms.txt`)).status).toBe(404);
  });

  it("/.well-known/llms.txt describes the instance owner's org", async () => {
    const res = await fetch(`${BASE_URL}/.well-known/llms.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("— Wren data context");
  });
});

describe("public org routes", () => {
  it("lists a public collection anonymously", async () => {
    const body = await (await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${pubCol}`)).json();
    expect(body.items.map((i: any) => i.data.name)).toEqual(["Widget"]);
  });

  it("the clean /orgs alias works for collections too", async () => {
    const body = await (await fetch(`${BASE_URL}/orgs/${slug}/${pubCol}`)).json();
    expect(body.total).toBe(1);
  });

  it("public _query works with POST and GET", async () => {
    const res = await post(`/api/v1/orgs/${slug}/${pubCol}/_query`, { select: ["name"] });
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((i: any) => i.data)).toEqual([{ name: "Widget" }]);
    const g = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${pubCol}/_query?select=kind`);
    expect((await g.json()).items.map((i: any) => i.data)).toEqual([{ kind: "a" }]);
  });

  it("public by-key reads", async () => {
    const keyed = `glossary${stamp}`;
    await fetch(`${BASE_URL}/api/v1/${keyed}/_schema`, {
      method: "PUT",
      headers: { Origin: BASE_URL, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ schema: { type: "object" }, naturalKey: "term" }),
    });
    await fetch(`${BASE_URL}/api/v1/${keyed}/by-key/wren`, {
      method: "PUT",
      headers: { Origin: BASE_URL, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ meaning: "a small bird" }),
    });
    await post("/api/v1/permissions", { principal: "*", resource: `collection:${keyed}`, access: "read" }, cookie);
    const res = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${keyed}/by-key/wren`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ term: "wren", meaning: "a small bird" });
    expect((await fetch(`${BASE_URL}/orgs/${slug}/${keyed}/by-key/nope`)).status).toBe(404);
  });

  it("private collections are 403 publicly", async () => {
    expect((await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${privCol}`)).status).toBe(403);
  });

  it("unsupported methods and bare org URLs", async () => {
    expect((await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${pubCol}`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${BASE_URL}/api/v1/orgs/${slug}`)).status).toBe(404);
    expect((await fetch(`${BASE_URL}/orgs/${slug}`)).status).toBe(404);
    expect((await fetch(`${BASE_URL}/api/v1/orgs/no-such-org-${stamp}/${pubCol}`)).status).toBe(404);
  });

  it("public materialized results are readable", async () => {
    await fetch(`${BASE_URL}/api/v1/${pubCol}/_materialized/names`, {
      method: "PUT",
      headers: { Origin: BASE_URL, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { select: ["name"] } }),
    });
    const list = await (await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${pubCol}/_materialized`)).json();
    expect(list.materialized.map((m: any) => m.name)).toEqual(["names"]);
    let result: any = null;
    for (let i = 0; i < 100 && !result; i++) {
      const res = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${pubCol}/_materialized/names`);
      if (res.status === 200) result = await res.json();
      else await new Promise(r => setTimeout(r, 50));
    }
    expect(result.result.data.items.map((i: any) => i.data)).toEqual([{ name: "Widget" }]);
  });
});

describe("the old React admin UI", () => {
  it("is gone: /oldadmin redirects to /admin/", async () => {
    for (const path of ["/oldadmin", "/oldadmin/", "/oldadmin/assets/app.js"]) {
      const res = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/");
    }
  });
});
