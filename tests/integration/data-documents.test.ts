import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, get, signUp, signIn } from "../setup";

const stamp = Date.now();
const email = `data-docs+${stamp}@wren.dev`;
const col = `docs${stamp}`;
const listCol = `list${stamp}`;
let cookie: string;

async function req(method: string, path: string, body?: unknown, raw?: string) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Origin: BASE_URL, Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}
async function create(collection: string, data: unknown) {
  const res = await post(`/api/v1/${collection}`, data, cookie);
  return (await res.json()) as { id: string; version: number; data: any };
}
const titles = (body: any) => body.items.map((i: any) => i.data.title);

beforeAll(async () => {
  await signUp(email, "secret123", "Data Docs");
  ({ cookie } = await signIn(email, "secret123"));

  // Created oldest → newest; the list is newest first
  const seed = [
    { title: "a", category: "news", year: 2023, author: { name: "Ann" }, tags: ["x", "y"] },
    { title: "b", category: "news", year: 2024, author: { name: "Bob" }, tags: ["y"] },
    { title: "c", category: "golf", year: 2025, author: { name: "Cat" }, tags: ["x"] },
    { title: "d", category: "golf", year: 2026, author: { name: "Dan" }, tags: [] },
    { title: "e", category: "opinion", year: 2022, author: { name: "Eve" }, tags: ["z"] },
  ];
  for (const s of seed) await create(listCol, s);
});

describe("GET /api/v1/collections", () => {
  it("lists collections with document counts", async () => {
    await create(col, { title: "counted" });
    const res = await get("/api/v1/collections", cookie);
    expect(res.status).toBe(200);
    const { collections } = await res.json();
    const list = collections.find((c: any) => c.name === listCol);
    expect(list.count).toBe(5);
    expect(list.updatedAt).toBeTruthy();
    expect(collections.find((c: any) => c.name === col).count).toBeGreaterThanOrEqual(1);
  });

  it("includes collections that only have a schema", async () => {
    const empty = `schemaonly${stamp}`;
    await req("PUT", `/api/v1/${empty}/_schema`, { type: "object" });
    const { collections } = await (await get("/api/v1/collections", cookie)).json();
    expect(collections.find((c: any) => c.name === empty)).toMatchObject({ name: empty, count: 0 });
  });
});

describe("document lifecycle", () => {
  it("create → get → update → delete, with a tombstone", async () => {
    const created = await create(col, { title: "v1", n: 1 });
    expect(created.version).toBe(1);

    const got = await (await get(`/api/v1/${col}/${created.id}`, cookie)).json();
    expect(got).toMatchObject({ id: created.id, version: 1, collection: col, data: { title: "v1", n: 1 }, labels: [] });

    const upd = await req("PUT", `/api/v1/${col}/${created.id}`, { title: "v2", n: 2 });
    expect(upd.status).toBe(200);
    const updBody = await upd.json();
    expect(updBody.version).toBe(2);
    expect(updBody.data).toEqual({ title: "v2", n: 2 });
    expect((await (await get(`/api/v1/${col}/${created.id}`, cookie)).json()).data.title).toBe("v2");

    const del = await req("DELETE", `/api/v1/${col}/${created.id}`);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ id: created.id, deleted: true });

    // Gone from reads, lists and history; a second delete is a 404
    expect((await get(`/api/v1/${col}/${created.id}`, cookie)).status).toBe(404);
    expect((await get(`/api/v1/${col}/${created.id}/versions`, cookie)).status).toBe(404);
    const list = await (await get(`/api/v1/${col}`, cookie)).json();
    expect(list.items.some((i: any) => i.id === created.id)).toBe(false);
    expect((await req("DELETE", `/api/v1/${col}/${created.id}`)).status).toBe(404);
    // Writes to a deleted document don't resurrect it
    expect((await req("PUT", `/api/v1/${col}/${created.id}`, { title: "zombie" })).status).toBe(404);
  });

  it("a document is only visible in its own collection", async () => {
    const { id } = await create(col, { title: "mine" });
    expect((await get(`/api/v1/${listCol}/${id}`, cookie)).status).toBe(404);
    expect((await req("PUT", `/api/v1/${listCol}/${id}`, { title: "x" })).status).toBe(404);
    expect((await req("DELETE", `/api/v1/${listCol}/${id}`)).status).toBe(404);
  });

  it("update of an unknown id is a 404", async () => {
    expect((await req("PUT", `/api/v1/${col}/nope-${stamp}`, { title: "x" })).status).toBe(404);
  });

  it("authenticated API responses are never shared-cacheable", async () => {
    const res = await get(`/api/v1/${listCol}`, cookie);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("HEAD answers like GET without a body", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/${listCol}`, { method: "HEAD", headers: { Origin: BASE_URL, Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await res.text()).toBe("");
  });

  it("an unknown sub-route is a 404", async () => {
    const { id } = await create(col, { title: "x" });
    expect((await get(`/api/v1/${col}/${id}/nonsense`, cookie)).status).toBe(404);
  });

  it("a malformed JSON body is a 400, not a 500", async () => {
    const res = await req("POST", `/api/v1/${col}`, undefined, "{not json");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/{collection} — paging, projection, filters", () => {
  it("lists newest first with total", async () => {
    const body = await (await get(`/api/v1/${listCol}`, cookie)).json();
    expect(body.collection).toBe(listCol);
    expect(body.total).toBe(5);
    expect(titles(body)).toEqual(["e", "d", "c", "b", "a"]);
    expect(body.items[0]).toHaveProperty("createdAt");
    expect(body.items[0].labels).toEqual([]);
  });

  it("pages with limit and offset; total stays the full count", async () => {
    const body = await (await get(`/api/v1/${listCol}?limit=2&offset=2`, cookie)).json();
    expect(titles(body)).toEqual(["c", "b"]);
    expect(body.total).toBe(5);
    const last = await (await get(`/api/v1/${listCol}?limit=2&offset=4`, cookie)).json();
    expect(titles(last)).toEqual(["a"]);
  });

  it("caps limit at 200", async () => {
    const res = await get(`/api/v1/${listCol}?limit=100000`, cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(5);
  });

  it("?select= projects top-level and nested fields", async () => {
    const body = await (await get(`/api/v1/${listCol}?select=title,author.name&limit=1`, cookie)).json();
    expect(body.items[0].data).toEqual({ title: "e", "author.name": "Eve" });
  });

  it("?select= rejects unsafe paths and too many fields", async () => {
    const bad = await get(`/api/v1/${listCol}?select=${encodeURIComponent("title;drop")}`, cookie);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("Invalid select path");
    const many = Array.from({ length: 21 }, (_, i) => `f${i}`).join(",");
    const tooMany = await get(`/api/v1/${listCol}?select=${many}`, cookie);
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error).toContain("Maximum 20");
  });

  const where = async (expr: string) => {
    const res = await get(`/api/v1/${listCol}?where=${encodeURIComponent(expr)}`, cookie);
    expect(res.status).toBe(200);
    return res.json();
  };

  it("?where= equality with : and =, and inequality", async () => {
    expect(titles(await where("category:news"))).toEqual(["b", "a"]);
    expect(titles(await where("category='golf'"))).toEqual(["d", "c"]);
    const ne = await where("category!=news");
    expect(titles(ne)).toEqual(["e", "d", "c"]);
    expect(ne.total).toBe(3);
  });

  it("?where= numeric comparisons", async () => {
    expect(titles(await where("year>=2025"))).toEqual(["d", "c"]);
    expect(titles(await where("year>2025"))).toEqual(["d"]);
    expect(titles(await where("year<2023"))).toEqual(["e"]);
    expect(titles(await where("year<=2023"))).toEqual(["e", "a"]);
  });

  it("?where= nested paths and regex", async () => {
    expect(titles(await where("author.name:Bob"))).toEqual(["b"]);
    expect(titles(await where("title~*^[a-b]$"))).toEqual(["b", "a"]);
  });

  it("?where= @> containment matches (the value is bound as a JSON string)", async () => {
    expect(titles(await where('tags@>["x"]'))).toEqual(["c", "a"]);
    expect(titles(await where('author@>{"name":"Ann"}'))).toEqual(["a"]);
  });

  it("?where= combines with AND / OR", async () => {
    expect(titles(await where("category:golf AND year>=2026"))).toEqual(["d"]);
    expect(titles(await where("category:opinion OR year<2024"))).toEqual(["e", "a"]);
  });

  it("?where= works together with ?label=", async () => {
    const { items } = await where("category:golf");
    await post(`/api/v1/${listCol}/${items[0].id}/labels`, { label: "featured" }, cookie);
    const body = await (await get(`/api/v1/${listCol}?label=featured&where=${encodeURIComponent("year>2000")}`, cookie)).json();
    expect(titles(body)).toEqual(["d"]);
    expect(body.total).toBe(1);
    expect(body.items[0].labels).toEqual(["featured"]);
    const none = await (await get(`/api/v1/${listCol}?label=featured&where=category:news`, cookie)).json();
    expect(none.total).toBe(0);
  });

  it("?where= rejects bad expressions", async () => {
    for (const expr of ["nooperator", "bad path:x", "x;drop:1"]) {
      const res = await get(`/api/v1/${listCol}?where=${encodeURIComponent(expr)}`, cookie);
      expect(res.status).toBe(400);
    }
  });

  it("?where= with the documented !~* operator filters instead of failing", async () => {
    const res = await get(`/api/v1/${listCol}?where=${encodeURIComponent("title!~*^[a-c]$")}`, cookie);
    expect(res.status).toBe(200);
    expect(titles(await res.json())).toEqual(["e", "d"]);
  });

  it("?where= containment on a nested path is not a 500", async () => {
    const res = await get(`/api/v1/${listCol}?where=${encodeURIComponent('author.name@>"Ann"')}`, cookie);
    expect(res.status).toBe(200);
    expect(titles(await res.json())).toEqual(["a"]);
  });
});

describe("versions, diff, rollback", () => {
  let id: string;

  beforeAll(async () => {
    id = (await create(col, { title: "one", draft: true })).id;
    await req("PUT", `/api/v1/${col}/${id}`, { title: "two", draft: true });
    await req("PUT", `/api/v1/${col}/${id}`, { title: "three", publishedAt: "2026-01-01" });
  });

  it("lists every version oldest first with its author", async () => {
    const body = await (await get(`/api/v1/${col}/${id}/versions`, cookie)).json();
    expect(body.id).toBe(id);
    expect(body.collection).toBe(col);
    expect(body.versions.map((v: any) => v.version)).toEqual([1, 2, 3]);
    expect(body.versions[0].createdBy).toBeTruthy();
    expect(body.versions[0].impersonatedBy).toBeNull();
  });

  it("reads a specific version", async () => {
    const res = await get(`/api/v1/${col}/${id}/versions/1`, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, collection: col, version: 1, data: { title: "one", draft: true } });
  });

  it("version errors: non-numeric is 400, missing is 404", async () => {
    expect((await get(`/api/v1/${col}/${id}/versions/abc`, cookie)).status).toBe(400);
    expect((await get(`/api/v1/${col}/${id}/versions/99`, cookie)).status).toBe(404);
    expect((await get(`/api/v1/${col}/unknown-${stamp}/versions`, cookie)).status).toBe(404);
  });

  it("diffs two versions with add/remove/replace ops", async () => {
    const res = await get(`/api/v1/${col}/${id}/diff?v1=1&v2=3`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id, collection: col, v1: 1, v2: 3 });
    const byPath = Object.fromEntries(body.diff.map((d: any) => [d.path, d]));
    expect(byPath["/title"]).toEqual({ op: "replace", path: "/title", value: "three", oldValue: "one" });
    expect(byPath["/draft"]).toEqual({ op: "remove", path: "/draft", oldValue: true });
    expect(byPath["/publishedAt"]).toEqual({ op: "add", path: "/publishedAt", value: "2026-01-01" });
  });

  it("diff errors: missing params 400, unknown version 404", async () => {
    expect((await get(`/api/v1/${col}/${id}/diff?v1=1`, cookie)).status).toBe(400);
    expect((await get(`/api/v1/${col}/${id}/diff?v1=1&v2=42`, cookie)).status).toBe(404);
  });

  it("rollback creates a new version with the old data", async () => {
    const res = await req("POST", `/api/v1/${col}/${id}/rollback/1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, version: 4, rolledBackTo: 1 });
    const doc = await (await get(`/api/v1/${col}/${id}`, cookie)).json();
    expect(doc.version).toBe(4);
    expect(doc.data).toEqual({ title: "one", draft: true });
    // History is kept
    const hist = await (await get(`/api/v1/${col}/${id}/versions`, cookie)).json();
    expect(hist.versions).toHaveLength(4);
  });

  it("rollback errors: bad version 400, unknown version or doc 404", async () => {
    expect((await req("POST", `/api/v1/${col}/${id}/rollback/abc`)).status).toBe(400);
    expect((await req("POST", `/api/v1/${col}/${id}/rollback/77`)).status).toBe(404);
    expect((await req("POST", `/api/v1/${col}/unknown-${stamp}/rollback/1`)).status).toBe(404);
  });

  it("old versions of a deleted document are no longer readable", async () => {
    const gone = (await create(col, { title: "secret" })).id;
    await req("DELETE", `/api/v1/${col}/${gone}`);
    expect((await get(`/api/v1/${col}/${gone}/versions/1`, cookie)).status).toBe(404);
  });
});

describe("labels", () => {
  let id: string;

  beforeAll(async () => {
    id = (await create(col, { title: "L1" })).id;
    await req("PUT", `/api/v1/${col}/${id}`, { title: "L2" });
  });

  it("pins a label to the current version and reads it back with ?label=", async () => {
    const res = await post(`/api/v1/${col}/${id}/labels`, { label: "published" }, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, label: "published", version: 2 });
    await req("PUT", `/api/v1/${col}/${id}`, { title: "L3" });
    const pinned = await (await get(`/api/v1/${col}/${id}?label=published`, cookie)).json();
    expect(pinned.version).toBe(2);
    expect(pinned.data.title).toBe("L2");
    const current = await (await get(`/api/v1/${col}/${id}`, cookie)).json();
    expect(current.version).toBe(3);
    expect(current.labels).toEqual(["published"]);
  });

  it("moves a label to an explicit version", async () => {
    const res = await post(`/api/v1/${col}/${id}/labels`, { label: "published", version: 1 }, cookie);
    expect((await res.json()).version).toBe(1);
    const pinned = await (await get(`/api/v1/${col}/${id}?label=published`, cookie)).json();
    expect(pinned.data.title).toBe("L1");
    const hist = await (await get(`/api/v1/${col}/${id}/versions`, cookie)).json();
    expect(hist.versions.find((v: any) => v.version === 1).labels).toEqual(["published"]);
    expect(hist.versions.find((v: any) => v.version === 2).labels).toEqual([]);
  });

  it("a label the document doesn't carry is a 404", async () => {
    expect((await get(`/api/v1/${col}/${id}?label=nope`, cookie)).status).toBe(404);
  });

  it("label errors: missing label 400, unknown version 404, unknown doc 404", async () => {
    expect((await post(`/api/v1/${col}/${id}/labels`, {}, cookie)).status).toBe(400);
    const v = await post(`/api/v1/${col}/${id}/labels`, { label: "x", version: 99 }, cookie);
    expect(v.status).toBe(404);
    expect((await v.json()).error).toBe("Version not found");
    expect((await post(`/api/v1/${col}/unknown-${stamp}/labels`, { label: "x" }, cookie)).status).toBe(404);
  });
});

describe("GET /api/v1/{collection}/{id}/paths", () => {
  it("lists the tree paths a document is assigned to", async () => {
    const { id } = await create(col, { title: "page" });
    const empty = await (await get(`/api/v1/${col}/${id}/paths`, cookie)).json();
    expect(empty).toEqual({ id, collection: col, paths: [] });

    await req("PUT", `/api/v1/tree/docsite${stamp}/b/page`, { documentId: id });
    await req("PUT", `/api/v1/tree/docsite${stamp}/a/page`, { documentId: id });
    const body = await (await get(`/api/v1/${col}/${id}/paths`, cookie)).json();
    expect(body.paths).toEqual([
      { tree: `docsite${stamp}`, path: "/a/page" },
      { tree: `docsite${stamp}`, path: "/b/page" },
    ]);
  });

  it("unknown document is a 404", async () => {
    expect((await get(`/api/v1/${col}/unknown-${stamp}/paths`, cookie)).status).toBe(404);
  });
});
