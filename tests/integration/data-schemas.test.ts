import { describe, it, expect, beforeAll } from "bun:test";
import postgres from "postgres";
import { BASE_URL, post, get, signUp, signIn } from "../setup";

const stamp = Date.now();
const email = `data-schemas+${stamp}@wren.dev`;
const col = `articles${stamp}`;
const keyCol = `pages${stamp}`;
let cookie: string;

async function req(method: string, path: string, body?: unknown, raw?: string) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Origin: BASE_URL, Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}
const articleSchema = {
  type: "object",
  required: ["title"],
  properties: { title: { type: "string" }, category: { type: "string", enum: ["news", "opinion"] } },
};

beforeAll(async () => {
  await signUp(email, "secret123", "Data Schemas");
  ({ cookie } = await signIn(email, "secret123"));
});

describe("JSON Schemas", () => {
  it("a collection without a schema is a 404 on GET and DELETE", async () => {
    expect((await get(`/api/v1/${col}/_schema`, cookie)).status).toBe(404);
    expect((await req("DELETE", `/api/v1/${col}/_schema`)).status).toBe(404);
  });

  it("documents written before a schema exists stay as they are", async () => {
    for (const data of [{ title: "ok", category: "news" }, { title: 42 }, { category: "sports" }]) {
      expect((await post(`/api/v1/${col}`, data, cookie)).status).toBe(201);
    }
  });

  it("dry-run: GET without a stored schema is a 404 with a hint", async () => {
    const res = await get(`/api/v1/${col}/_schema/validate`, cookie);
    expect(res.status).toBe(404);
    expect((await res.json()).hint).toContain("_schema");
  });

  it("dry-run: POST a proposed schema (wrapper form) reports failing documents", async () => {
    const res = await post(`/api/v1/${col}/_schema/validate`, { schema: articleSchema }, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ collection: col, schemaSource: "proposed", checked: 3, valid: 1, invalid: 2, limitReached: false, failuresTruncated: false });
    const errors = body.failures.flatMap((f: any) => f.errors);
    expect(errors).toContain("/title must be string");
    expect(errors.some((e: string) => e.includes("must have required property 'title'"))).toBe(true);
    expect(body.failures[0].version).toBe(1);
  });

  it("dry-run: the bare-schema body form and the caps", async () => {
    const res = await post(`/api/v1/${col}/_schema/validate?limit=1&max=2`, articleSchema, cookie);
    const body = await res.json();
    expect(body.checked).toBe(2);
    expect(body.limitReached).toBe(true);
    expect(body.failures).toHaveLength(1);
    expect(body.failuresTruncated).toBe(body.invalid > 1);
  });

  it("dry-run: an invalid proposed schema is a 422", async () => {
    const res = await post(`/api/v1/${col}/_schema/validate`, { schema: { type: "not-a-type" } }, cookie);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("Invalid JSON Schema");
  });

  it("dry-run: other methods are 405", async () => {
    expect((await req("PUT", `/api/v1/${col}/_schema/validate`, {})).status).toBe(405);
  });

  it("sets a schema with display name and list columns, and reads it back", async () => {
    const res = await req("PUT", `/api/v1/${col}/_schema`, {
      schema: articleSchema, displayName: "{title}", listColumns: ["title", " ", "category"],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ collection: col, collectionType: "json", displayName: "{title}", listColumns: ["title", "category"], naturalKey: null, indexes: [] });

    const got = await (await get(`/api/v1/${col}/_schema`, cookie)).json();
    expect(got).toMatchObject({ collection: col, collectionType: "json", schema: articleSchema, displayName: "{title}", listColumns: ["title", "category"] });
    expect(got.updatedAt).toBeTruthy();
  });

  it("dry-run: GET runs the stored schema", async () => {
    const body = await (await get(`/api/v1/${col}/_schema/validate`, cookie)).json();
    expect(body.schemaSource).toBe("current");
    expect(body.invalid).toBe(2);
  });

  it("dry-run: a POST without a body falls back to the stored schema", async () => {
    const body = await (await req("POST", `/api/v1/${col}/_schema/validate`, undefined, "")).json();
    expect(body.schemaSource).toBe("current");
  });

  it("creates and updates are validated", async () => {
    const bad = await post(`/api/v1/${col}`, { title: "x", category: "sports" }, cookie);
    expect(bad.status).toBe(422);
    const body = await bad.json();
    expect(body.error).toBe("Schema validation failed");
    expect(body.details[0]).toContain("/category");

    const ok = await (await post(`/api/v1/${col}`, { title: "fine", category: "opinion" }, cookie)).json();
    const badUpdate = await req("PUT", `/api/v1/${col}/${ok.id}`, { category: "news" });
    expect(badUpdate.status).toBe(422);
    expect((await (await get(`/api/v1/${col}/${ok.id}`, cookie)).json()).version).toBe(1);
  });

  it("a plain (unwrapped) schema body is accepted", async () => {
    const res = await req("PUT", `/api/v1/${col}/_schema`, { type: "object", required: ["title"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema).toEqual({ type: "object", required: ["title"] });
    expect(body.displayName).toBeNull();
  });

  it("an invalid schema is a 422 and leaves the old one in place", async () => {
    const res = await req("PUT", `/api/v1/${col}/_schema`, { schema: { type: 12 } });
    expect(res.status).toBe(422);
    expect((await (await get(`/api/v1/${col}/_schema`, cookie)).json()).schema.required).toEqual(["title"]);
  });

  it("index declarations are stored and validated", async () => {
    const res = await req("PUT", `/api/v1/${col}/_schema`, {
      schema: articleSchema,
      indexes: [{ path: "category", kind: "btree" }, { path: "tags", kind: "gin" }, { path: "title", kind: "trigram" }, { path: "meta.slug", kind: "btree" }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).indexes).toHaveLength(4);
    // Changing the set drops the removed ones
    const shrink = await req("PUT", `/api/v1/${col}/_schema`, { schema: articleSchema, indexes: [{ path: "category", kind: "btree" }] });
    expect((await shrink.json()).indexes).toEqual([{ path: "category", kind: "btree" }]);
    expect((await (await get(`/api/v1/${col}/_schema`, cookie)).json()).indexes).toEqual([{ path: "category", kind: "btree" }]);

    for (const indexes of [
      "nope",
      Array.from({ length: 11 }, (_, i) => ({ path: `f${i}`, kind: "btree" })),
      [{ kind: "btree" }],
      [{ path: "x", kind: "hash" }],
      [{ path: "x;drop", kind: "btree" }],
    ]) {
      const bad = await req("PUT", `/api/v1/${col}/_schema`, { schema: articleSchema, indexes });
      expect(bad.status).toBe(400);
    }
  });

  it("declared indexes are actually created in the tenant schema", async () => {
    // reconcileIndexes sets search_path on one pooled connection and runs the DDL on another,
    // so CREATE INDEX on the unqualified "versions" table fails ("relation does not exist").
    const idxCol = `indexed${stamp}`;
    await req("PUT", `/api/v1/${idxCol}/_schema`, { schema: { type: "object" }, indexes: [{ path: "category", kind: "btree" }] });
    const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      let found = 0;
      for (let i = 0; i < 40 && !found; i++) {
        found = (await db`SELECT 1 FROM pg_indexes WHERE indexname = ${`idx_q_${idxCol}_category_btree`}`).length;
        if (!found) await new Promise(r => setTimeout(r, 50));
      }
      expect(found).toBe(1);
    } finally {
      await db.end();
    }
  });

  it("binary collections store no JSON schema and skip validation", async () => {
    const bin = `bin${stamp}`;
    const res = await req("PUT", `/api/v1/${bin}/_schema`, { collectionType: "binary", schema: { type: "string" } });
    expect((await res.json())).toMatchObject({ collectionType: "binary", schema: null });
    const got = await (await get(`/api/v1/${bin}/_schema`, cookie)).json();
    expect(got).toMatchObject({ collectionType: "binary", schema: null });
    // JSON writes aren't validated against the (empty) schema
    expect((await post(`/api/v1/${bin}`, { anything: true }, cookie)).status).toBe(201);
    // Dry-run has nothing to check
    expect((await get(`/api/v1/${bin}/_schema/validate`, cookie)).status).toBe(400);
  });

  it("deletes the schema; writes are no longer validated", async () => {
    const res = await req("DELETE", `/api/v1/${col}/_schema`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ collection: col, deleted: true });
    expect((await post(`/api/v1/${col}`, { title: 1 }, cookie)).status).toBe(201);
  });
});

describe("natural keys", () => {
  beforeAll(async () => {
    await req("PUT", `/api/v1/${keyCol}/_schema`, {
      schema: { type: "object", properties: { slug: { type: "string" }, title: { type: "string" } } },
      naturalKey: " slug ",
    });
  });

  it("the schema reports the trimmed natural key", async () => {
    expect((await (await get(`/api/v1/${keyCol}/_schema`, cookie)).json()).naturalKey).toBe("slug");
  });

  it("by-key routes need a natural key on the collection", async () => {
    const plain = `plain${stamp}`;
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await req(method, `/api/v1/${plain}/by-key/x`, method === "PUT" ? { title: "x" } : undefined);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("No natural key configured");
    }
  });

  it("PUT by-key creates (201) and then updates (200) the same document", async () => {
    const created = await req("PUT", `/api/v1/${keyCol}/by-key/hello`, { title: "Hello" });
    expect(created.status).toBe(201);
    const c = await created.json();
    expect(c).toMatchObject({ version: 1, naturalKey: "hello", data: { slug: "hello", title: "Hello" } });

    const updated = await req("PUT", `/api/v1/${keyCol}/by-key/hello`, { slug: "hello", title: "Hello again" });
    expect(updated.status).toBe(200);
    const u = await updated.json();
    expect(u.id).toBe(c.id);
    expect(u.version).toBe(2);

    const got = await (await get(`/api/v1/${keyCol}/by-key/hello`, cookie)).json();
    expect(got).toMatchObject({ id: c.id, version: 2, data: { title: "Hello again" } });
  });

  it("a non-object body becomes just the key", async () => {
    const res = await req("PUT", `/api/v1/${keyCol}/by-key/bare`, "just a string");
    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({ slug: "bare" });
  });

  it("URL-encoded keys round-trip", async () => {
    const key = "with space/and-slash";
    const res = await req("PUT", `/api/v1/${keyCol}/by-key/${encodeURIComponent(key)}`, { title: "enc" });
    expect(res.status).toBe(201);
    const got = await get(`/api/v1/${keyCol}/by-key/${encodeURIComponent(key)}`, cookie);
    expect((await got.json()).data.slug).toBe(key);
  });

  it("a body key that disagrees with the URL is a 400", async () => {
    const res = await req("PUT", `/api/v1/${keyCol}/by-key/one`, { slug: "two" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Natural key mismatch");
  });

  it("schema validation applies to upserts", async () => {
    const res = await req("PUT", `/api/v1/${keyCol}/by-key/typed`, { title: 5 });
    expect(res.status).toBe(422);
  });

  it("GET by-key honors ?label=", async () => {
    await req("PUT", `/api/v1/${keyCol}/by-key/lab`, { title: "v1" });
    const { id } = await (await get(`/api/v1/${keyCol}/by-key/lab`, cookie)).json();
    await post(`/api/v1/${keyCol}/${id}/labels`, { label: "published" }, cookie);
    await req("PUT", `/api/v1/${keyCol}/by-key/lab`, { title: "v2" });
    const pub = await (await get(`/api/v1/${keyCol}/by-key/lab?label=published`, cookie)).json();
    expect(pub.data.title).toBe("v1");
    expect((await get(`/api/v1/${keyCol}/by-key/lab?label=nope`, cookie)).status).toBe(404);
  });

  it("POST extracts the key; a second POST with the same key is a 409", async () => {
    const first = await post(`/api/v1/${keyCol}`, { slug: " dup ", title: "first" }, cookie);
    expect(first.status).toBe(201);
    expect((await first.json()).naturalKey).toBe("dup");
    const second = await post(`/api/v1/${keyCol}`, { slug: "dup", title: "second" }, cookie);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("Natural key conflict");
  });

  it("documents without a usable key value don't get one", async () => {
    for (const data of [{ title: "no slug" }, { slug: 12 }, { slug: "   " }, { slug: null }]) {
      const res = await post(`/api/v1/${keyCol}`, data, cookie);
      if (res.status === 201) expect((await res.json()).naturalKey).toBeNull();
    }
  });

  it("renaming a key onto an existing one is a 409; renaming to a free one moves it", async () => {
    const { id } = await (await post(`/api/v1/${keyCol}`, { slug: "mover", title: "m" }, cookie)).json();
    const clash = await req("PUT", `/api/v1/${keyCol}/${id}`, { slug: "dup", title: "m" });
    expect(clash.status).toBe(409);
    const moved = await req("PUT", `/api/v1/${keyCol}/${id}`, { slug: "moved", title: "m" });
    expect((await moved.json()).naturalKey).toBe("moved");
    expect((await get(`/api/v1/${keyCol}/by-key/mover`, cookie)).status).toBe(404);
    expect((await (await get(`/api/v1/${keyCol}/by-key/moved`, cookie)).json()).id).toBe(id);
  });

  it("DELETE by-key soft-deletes, frees the key, and is 404 afterwards", async () => {
    const { id } = await (await req("PUT", `/api/v1/${keyCol}/by-key/gone`, { title: "bye" })).json();
    const res = await req("DELETE", `/api/v1/${keyCol}/by-key/gone`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, deleted: true });
    expect((await get(`/api/v1/${keyCol}/by-key/gone`, cookie)).status).toBe(404);
    expect((await req("DELETE", `/api/v1/${keyCol}/by-key/gone`)).status).toBe(404);
    // The key can be reused by a new document
    const again = await req("PUT", `/api/v1/${keyCol}/by-key/gone`, { title: "back" });
    expect(again.status).toBe(201);
    expect((await again.json()).id).not.toBe(id);
  });

  it("other methods on by-key are 405", async () => {
    expect((await req("POST", `/api/v1/${keyCol}/by-key/hello`, {})).status).toBe(405);
  });
});
