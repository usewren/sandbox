import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, get, signUp, signIn } from "../setup";

const email = `public+${Date.now()}@wren.dev`;
const col = `pubdocs${Date.now()}`;
const secretCol = `secret${Date.now()}`;
let cookie: string;
let slug: string;
let docId: string;
let secretId: string;

async function put(path: string, body: unknown) {
  return fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json", Origin: BASE_URL, Cookie: cookie },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await signUp(email, "secret123", "Public Test");
  ({ cookie } = await signIn(email, "secret123"));
  slug = (await (await get("/api/v1/me", cookie)).json()).org.slug;

  // v1 is published, v2 is an unpublished draft
  docId = (await (await post(`/api/v1/${col}`, { title: "published-v1" }, cookie)).json()).id;
  await post(`/api/v1/${col}/${docId}/labels`, { label: "published" }, cookie);
  await put(`/api/v1/${col}/${docId}`, { title: "draft-v2" });

  await post("/api/v1/permissions", { principal: "*", resource: `collection:${col}`, access: "read", labelFilter: "published" }, cookie);

  // A binary in a collection with no public rule
  const form = new FormData();
  form.append("file", new File(["top secret"], "secret.txt", { type: "text/plain" }));
  const up = await fetch(`${BASE_URL}/api/v1/${secretCol}`, { method: "POST", headers: { Origin: BASE_URL, Cookie: cookie }, body: form });
  secretId = (await up.json()).id;
});

describe("public access", () => {
  it("public list only shows the published version", async () => {
    const body = await (await get(`/api/v1/orgs/${slug}/${col}`)).json();
    expect(body.items.map((i: any) => i.data.title)).toEqual(["published-v1"]);
  });

  it("?label= cannot bypass the rule's label filter on list", async () => {
    for (const q of ["?label=", "?label=draft"]) {
      const res = await get(`/api/v1/orgs/${slug}/${col}${q}`);
      const body = await res.json();
      expect(body.items.map((i: any) => i.data.title)).toEqual(["published-v1"]);
    }
  });

  it("public POST is rejected instead of silently listing", async () => {
    const res = await post(`/api/v1/orgs/${slug}/${col}`, { title: "nope" });
    expect(res.status).toBe(405);
  });

  it("raw cannot read a document from another (private) collection", async () => {
    expect(secretId).toBeTruthy();
    for (const q of ["", "?version=1"]) {
      const res = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${col}/${secretId}/raw${q}`);
      expect(res.status).toBe(404);
    }
  });

  it("public error responses are not cacheable", async () => {
    const res = await get(`/api/v1/orgs/${slug}/${col}/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("public llms.txt shows only published samples and the URL map", async () => {
    const text = await (await fetch(`${BASE_URL}/orgs/${slug}/llms.txt`)).text();
    expect(text).toContain("published-v1");
    expect(text).not.toContain("draft-v2");
    expect(text).toContain(`/orgs/${slug}/tree/{tree}/{path}`);
    expect(text).not.toMatch(/\/api\/keys\b/);
  });
});

describe("trees and caching", () => {
  const tree = `site${Date.now()}`;
  let fileId: string;

  beforeAll(async () => {
    const form = new FormData();
    form.append("file", new File(["<h1>v1</h1>"], "index.html", { type: "text/html" }));
    const up = await fetch(`${BASE_URL}/api/v1/${secretCol}`, { method: "POST", headers: { Origin: BASE_URL, Cookie: cookie }, body: form });
    fileId = (await up.json()).id;
    await put(`/api/v1/tree/${tree}/index.html`, { documentId: fileId });
    await post("/api/v1/permissions", { principal: "*", resource: `tree:${tree}`, access: "read", labelFilter: "published" }, cookie);
  });

  it("upload responses include the file metadata and sha256", async () => {
    const form = new FormData();
    form.append("file", new File(["abc"], "a.txt", { type: "text/plain" }));
    const res = await fetch(`${BASE_URL}/api/v1/${secretCol}`, { method: "POST", headers: { Origin: BASE_URL, Cookie: cookie }, body: form });
    const body = await res.json();
    expect(body.data).toMatchObject({ _binary: true, filename: "a.txt", size: 3 });
    expect(body.data.mimeType).toStartWith("text/plain");
    expect(body.data.sha256).toBe(new Bun.CryptoHasher("sha256").update("abc").digest("hex"));
  });

  it("uploads record a sha256 of the bytes", async () => {
    const doc = await (await get(`/api/v1/${secretCol}/${fileId}`, cookie)).json();
    expect(doc.data.sha256).toBe(new Bun.CryptoHasher("sha256").update("<h1>v1</h1>").digest("hex"));
  });

  it("a deployed-but-unpromoted file is 404 publicly, not a 200 stub", async () => {
    const res = await fetch(`${BASE_URL}/orgs/${slug}/tree/${tree}/index.html`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("after promote the file is served publicly with Vary: Accept kept", async () => {
    await post(`/api/v1/${secretCol}/${fileId}/labels`, { label: "published" }, cookie);
    const res = await fetch(`${BASE_URL}/orgs/${slug}/tree/${tree}/index.html`, { headers: { Accept: "text/html", Origin: BASE_URL } });
    expect(await res.text()).toBe("<h1>v1</h1>");
    expect(res.headers.get("vary") ?? "").toContain("Accept");
  });

  it("authenticated file and tree reads are never shared-cacheable", async () => {
    for (const path of [`/api/v1/${secretCol}/${fileId}/raw`, `/api/v1/tree/${tree}/index.html`]) {
      const res = await fetch(`${BASE_URL}${path}`, { headers: { Origin: BASE_URL, Cookie: cookie, Accept: "text/html" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});

describe("CORS", () => {
  const foreign = "https://example.com";

  it("public routes are readable from any origin", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${col}`, { headers: { Origin: foreign } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("public routes send * even to trusted origins, so a cached response works everywhere", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/${col}`, { headers: { Origin: BASE_URL } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("auth routes don't echo foreign origins", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/get-session`, { method: "OPTIONS", headers: { Origin: foreign } });
    expect(res.headers.get("access-control-allow-origin") ?? "").not.toBe(foreign);
  });

  it("private API allows Bearer from other origins but never cookies", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/me`, {
      method: "OPTIONS",
      headers: { Origin: foreign, "Access-Control-Request-Headers": "authorization" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(foreign);
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("same-origin still gets credentials", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/me`, { method: "OPTIONS", headers: { Origin: BASE_URL } });
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
