import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, get, signUp, signIn } from "../setup";

const stamp = Date.now();
const email = `data-query+${stamp}@wren.dev`;
const col = `results${stamp}`;
const mcol = `matsrc${stamp}`;
let cookie: string;

async function req(method: string, path: string, body?: unknown, raw?: string) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Origin: BASE_URL, Cookie: cookie, Accept: "application/json", "Content-Type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}
const query = (body: unknown, collection = col) => req("POST", `/api/v1/${collection}/_query`, body);
const q64 = (body: unknown) => Buffer.from(JSON.stringify(body)).toString("base64url");

// Polls until fn returns a truthy value or the timeout passes
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  await signUp(email, "secret123", "Data Query");
  ({ cookie } = await signIn(email, "secret123"));

  // Tournament results with nested arrays for unnest aggregation
  const seed = [
    { name: "spring", city: "Bern", year: 2024, score: 10, divisions: [{ players: [{ id: "p1" }, { id: "p2" }] }] },
    { name: "summer", city: "Bern", year: 2025, score: 20, divisions: [{ players: [{ id: "p2" }, { id: "p3" }] }] },
    { name: "autumn", city: "Basel", year: 2025, score: 30, divisions: [{ players: [{ id: "p1" }] }, { players: [{ id: "p4" }] }] },
    { name: "winter", city: "Zurich", year: 2026, score: 40, divisions: [] },
  ];
  for (const s of seed) await post(`/api/v1/${col}`, s, cookie);
});

describe("POST /api/v1/{collection}/_query — documents", () => {
  it("returns all documents newest first with no cursor when they fit", async () => {
    const res = await query({});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: any) => i.data.name)).toEqual(["winter", "autumn", "summer", "spring"]);
    expect(body.cursor).toBeNull();
  });

  it("projects with select and filters with where", async () => {
    const body = await (await query({ select: ["name", "city"], where: "city:Bern" })).json();
    expect(body.items.map((i: any) => i.data)).toEqual([
      { name: "summer", city: "Bern" },
      { name: "spring", city: "Bern" },
    ]);
  });

  it("returns a cursor while more documents remain", async () => {
    const first = await (await query({ select: ["name"], limit: 3 })).json();
    expect(first.items).toHaveLength(3);
    expect(first.cursor).toBeTruthy();
    expect(JSON.parse(Buffer.from(first.cursor, "base64url").toString()).id).toBe(first.items[2].id);
    const all = await (await query({ limit: 4 })).json();
    expect(all.cursor).toBeNull();
  });

  it("cursor paging visits every document exactly once", async () => {
    // The cursor compares ids only while the order is created_at, so random ids skip and repeat
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const body = await (await query({ select: ["name"], limit: 1, ...(cursor ? { cursor } : {}) })).json();
      seen.push(...body.items.map((it: any) => it.data.name));
      cursor = body.cursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(["winter", "autumn", "summer", "spring"]);
  });

  it("filters on array paths with []", async () => {
    const body = await (await query({ select: ["name"], where: "divisions[].players[].id:p3" })).json();
    expect(body.items.map((i: any) => i.data.name)).toEqual(["summer"]);
    // An object step before the array; nothing has it
    const none = await (await query({ where: "meta.lists[].id:p1" })).json();
    expect(none.items).toEqual([]);
  });

  it("clamps the limit to at least 1", async () => {
    const body = await (await query({ limit: 0 })).json();
    expect(body.items).toHaveLength(1);
    expect(body.cursor).toBeTruthy();
  });

  it("caps the limit at 1000", async () => {
    const res = await query({ limit: 5000 });
    expect(res.status).toBe(200);
    expect((await res.json()).items).toHaveLength(4);
  });

  it("reads the labeled version with label", async () => {
    const { items } = await (await query({ where: "name:winter" })).json();
    const id = items[0].id;
    await post(`/api/v1/${col}/${id}/labels`, { label: "final" }, cookie);
    await req("PUT", `/api/v1/${col}/${id}`, { ...items[0].data, score: 99 });
    const body = await (await query({ label: "final" })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].data.score).toBe(40);
    expect(body.items[0].version).toBe(1);
  });

  it("GET with individual params", async () => {
    const res = await get(`/api/v1/${col}/_query?select=name&where=${encodeURIComponent("year>=2025")}&limit=10`, cookie);
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((i: any) => i.data.name)).toEqual(["winter", "autumn", "summer"]);
  });

  it("GET with ?label= and ?cursor=", async () => {
    const first = await (await get(`/api/v1/${col}/_query?limit=1`, cookie)).json();
    const next = await (await get(`/api/v1/${col}/_query?limit=1&cursor=${first.cursor}`, cookie)).json();
    expect(next.items[0].id).not.toBe(first.items[0].id);
    const labeled = await (await get(`/api/v1/${col}/_query?label=final`, cookie)).json();
    expect(labeled.items).toHaveLength(1);
  });

  it("GET with ?q= base64url JSON", async () => {
    const res = await get(`/api/v1/${col}/_query?q=${q64({ where: "city:Basel", select: ["name"] })}`, cookie);
    expect((await res.json()).items.map((i: any) => i.data)).toEqual([{ name: "autumn" }]);
  });
});

describe("POST /api/v1/{collection}/_query — aggregation", () => {
  it("groups and counts with the documented metric ops", async () => {
    const res = await query({
      aggregate: {
        groupBy: ["city"],
        metrics: {
          n: { count: "name" }, total: { sum: "score" }, lo: { min: "name" }, hi: { max: "name" },
          avg: { avg: "year" }, years: { countDistinct: "year" },
        },
      },
    });
    expect(res.status).toBe(200);
    const { rows } = await res.json();
    expect(rows.map(({ avg, ...r }: any) => ({ ...r, avg: Number(avg) }))).toEqual([
      { key: { city: "Basel" }, n: 1, total: 30, lo: "autumn", hi: "autumn", avg: 2025, years: 1 },
      { key: { city: "Bern" }, n: 2, total: 30, lo: "spring", hi: "summer", avg: 2024.5, years: 2 },
      { key: { city: "Zurich" }, n: 1, total: 99, lo: "winter", hi: "winter", avg: 2026, years: 1 },
    ]);
  });

  it("avg metrics come back as numbers like count and sum", async () => {
    // Postgres returns AVG as "2024.5000000000000000", which fails the exact round-trip check
    const { rows } = await (await query({ aggregate: { groupBy: ["city"], metrics: { avg: { avg: "year" } } } })).json();
    expect(rows.map((r: any) => r.avg)).toEqual([2025, 2024.5, 2026]);
  });

  it("metrics over a missing field are null", async () => {
    const body = await (await query({ aggregate: { groupBy: ["$collection"], metrics: { none: { min: "missing" } } } })).json();
    expect(body.rows).toEqual([{ key: { $collection: col }, none: null }]);
  });

  it("unnests array paths and counts distinct leaves", async () => {
    const body = await (await query({
      aggregate: { groupBy: ["$collection"], metrics: { players: { countDistinct: "divisions[].players[].id" } } },
    })).json();
    expect(body.rows).toEqual([{ key: { $collection: col }, players: 4 }]);
  });

  it("groups by an array path", async () => {
    const body = await (await query({
      aggregate: { groupBy: ["divisions[].players[].id"], metrics: { events: { count: "name" } } },
    })).json();
    expect(body.rows.map((r: any) => [r.key["divisions[].players[].id"], r.events])).toEqual([
      ["p1", 2], ["p2", 2], ["p3", 1], ["p4", 1],
    ]);
  });

  it("defaults to grouping per document and adds select fields to the key", async () => {
    const body = await (await query({
      select: ["name"],
      where: "city:Bern",
      aggregate: { metrics: { players: { count: "divisions[].players[].id" } } },
    })).json();
    expect(body.rows).toHaveLength(2);
    for (const r of body.rows) {
      expect(r.key.$documentId).toBeTruthy();
      expect(r.players).toBe(2);
    }
    expect(body.rows.map((r: any) => r.key.name).sort()).toEqual(["spring", "summer"]);
  });

  it("groups by $path from tree assignments", async () => {
    const { items } = await (await query({ where: "name:spring" })).json();
    await req("PUT", `/api/v1/tree/qtree${stamp}/events/spring`, { documentId: items[0].id });
    const body = await (await query({
      where: "name:spring",
      aggregate: { groupBy: ["$path"], metrics: { n: { count: "name" } } },
    })).json();
    expect(body.rows).toEqual([{ key: { $path: "/events/spring" }, n: 1 }]);
  });

  it("aggregates the labeled version", async () => {
    const body = await (await query({ label: "final", aggregate: { groupBy: ["city"], metrics: { s: { sum: "score" } } } })).json();
    expect(body.rows).toEqual([{ key: { city: "Zurich" }, s: 40 }]);
  });

  it("aggregate via GET ?q=", async () => {
    const res = await get(`/api/v1/${col}/_query?q=${q64({ aggregate: { groupBy: ["year"], metrics: { n: { count: "name" } } } })}`, cookie);
    const { rows } = await res.json();
    expect(rows.map((r: any) => [r.key.year, r.n])).toEqual([["2024", 1], ["2025", 2], ["2026", 1]]);
  });
});

describe("_query validation errors", () => {
  const bad = async (body: unknown, fragment: string) => {
    const res = await query(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(fragment);
  };

  it("rejects a malformed body", async () => {
    const res = await req("POST", `/api/v1/${col}/_query`, undefined, "{nope");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid JSON body");
  });

  it("rejects a malformed ?q=", async () => {
    const res = await get(`/api/v1/${col}/_query?q=not-base64-json`, cookie);
    expect(res.status).toBe(400);
  });

  it("rejects bad select paths and too many fields", async () => {
    await bad({ select: ["ok", "drop table"] }, "Invalid select path");
    await bad({ select: Array.from({ length: 21 }, (_, i) => `f${i}`) }, "Maximum 20");
  });

  it("rejects too many metrics, bad metric paths and bad groupBy", async () => {
    const metrics = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`m${i}`, { count: "x" }]));
    await bad({ aggregate: { metrics } }, "Maximum 10 metrics");
    await bad({ aggregate: { metrics: { m: { count: "bad path" } } } }, "Invalid path");
    await bad({ aggregate: { metrics: { m: { count: "a[].b[].c[].d[].e[]" } } } }, "nesting too deep");
    await bad({ aggregate: { metrics: { m: { count: "x", by: "no good" } } } }, "Invalid path");
    await bad({ aggregate: { groupBy: ["no good"], metrics: { m: { count: "x" } } } }, "Invalid groupBy path");
  });

  it("rejects bad where and bad cursor", async () => {
    await bad({ where: "garbage" }, "Invalid filter expression");
    await bad({ cursor: "!!!" }, "Invalid cursor");
  });

  it("a query that fails in the database is a 500 with the reason", async () => {
    // sum over a non-numeric field
    const res = await query({ aggregate: { groupBy: ["city"], metrics: { s: { sum: "name" } } } });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("Query failed");
  });

  it("other methods on _query are not routed", async () => {
    expect((await req("DELETE", `/api/v1/${col}/_query`)).status).toBe(404);
  });
});

describe("materialized queries", () => {
  const mat = (name: string) => `/api/v1/${mcol}/_materialized/${name}`;
  const result = async (name: string) => {
    const res = await get(mat(name), cookie);
    return res.status === 200 ? (await res.json()).result : null;
  };

  beforeAll(async () => {
    await post(`/api/v1/${mcol}`, { title: "first", kind: "a" }, cookie);
  });

  it("creates a query and fills its result right away", async () => {
    const res = await req("PUT", mat("slim"), { query: { select: ["title"] } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ collection: mcol, name: "slim", refreshOn: "write" });
    expect(body.resultDocId).toBeTruthy();
    const r = await until(() => result("slim"));
    expect(r.data.items.map((i: any) => i.data)).toEqual([{ title: "first" }]);
    expect(r.data.refreshedAt).toBeTruthy();
    expect(r.id).toBe(body.resultDocId);
  });

  it("refreshes on create, update and delete", async () => {
    const { id } = await (await post(`/api/v1/${mcol}`, { title: "second", kind: "b" }, cookie)).json();
    await until(async () => (await result("slim"))?.data.items.length === 2);

    await req("PUT", `/api/v1/${mcol}/${id}`, { title: "second-edited", kind: "b" });
    await until(async () => (await result("slim"))?.data.items.some((i: any) => i.data.title === "second-edited"));

    await req("DELETE", `/api/v1/${mcol}/${id}`);
    const r = await until(async () => {
      const cur = await result("slim");
      return cur?.data.items.length === 1 ? cur : null;
    });
    expect(r.data.items[0].data.title).toBe("first");
  });

  it("aggregate queries store rows", async () => {
    await req("PUT", mat("bykind"), { query: { aggregate: { groupBy: ["kind"], metrics: { n: { count: "title" } } } } });
    const r = await until(() => result("bykind"));
    expect(r.data.rows).toEqual([{ key: { kind: "a" }, n: 1 }]);
  });

  it("manual queries don't refresh on write; a PUT refreshes them", async () => {
    await req("PUT", mat("manual"), { query: { select: ["title"] }, refreshOn: "manual" });
    const first = await until(() => result("manual"));
    expect(first.data.items).toHaveLength(1);

    await post(`/api/v1/${mcol}`, { title: "third", kind: "a" }, cookie);
    // The write-triggered query proves the refresh round has run
    await until(async () => (await result("slim"))?.data.items.length === 2);
    expect((await result("manual")).data.items).toHaveLength(1);

    await req("PUT", mat("manual"), { query: { select: ["title"] }, refreshOn: "manual" });
    await until(async () => (await result("manual"))?.data.items.length === 2);
  });

  it("lists definitions by name", async () => {
    const body = await (await get(`/api/v1/${mcol}/_materialized`, cookie)).json();
    expect(body.collection).toBe(mcol);
    expect(body.materialized.map((m: any) => m.name)).toEqual(["bykind", "manual", "slim"]);
    expect(body.materialized.find((m: any) => m.name === "manual").refreshOn).toBe("manual");
  });

  it("validates the definition", async () => {
    expect((await req("PUT", mat("x"), {})).status).toBe(400);
    expect((await req("PUT", mat("x"), { query: {}, refreshOn: "hourly" })).status).toBe(400);
    const badName = await req("PUT", mat("1bad"), { query: {} });
    expect(badName.status).toBe(400);
    expect((await badName.json()).error).toBe("Invalid materialized query name");
  });

  it("allows at most 5 per collection, but updating an existing one still works", async () => {
    await req("PUT", mat("four"), { query: {} });
    await req("PUT", mat("five"), { query: {} });
    const sixth = await req("PUT", mat("six"), { query: {} });
    expect(sixth.status).toBe(400);
    expect((await sixth.json()).error).toContain("Maximum 5");
    const update = await req("PUT", mat("five"), { query: { select: ["kind"] } });
    expect(update.status).toBe(200);
  });

  it("deletes a definition; a second delete and a read are 404", async () => {
    const res = await req("DELETE", mat("four"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ collection: mcol, name: "four", deleted: true });
    expect((await req("DELETE", mat("four"))).status).toBe(404);
    expect((await get(mat("four"), cookie)).status).toBe(404);
  });

  it("other methods are 405", async () => {
    expect((await req("POST", mat("slim"), {})).status).toBe(405);
    expect((await req("PUT", `/api/v1/${mcol}/_materialized`, {})).status).toBe(405);
  });

  it("a rollback refreshes materialized queries like any other write", async () => {
    // The rollback route purges caches but never calls refreshMaterializedForCollection
    const rcol = `rollsrc${stamp}`;
    const { id } = await (await post(`/api/v1/${rcol}`, { title: "r1" }, cookie)).json();
    await req("PUT", `/api/v1/${rcol}/_materialized/titles`, { query: { select: ["title"] } });
    await req("PUT", `/api/v1/${rcol}/${id}`, { title: "r2" });
    const titles = async () => {
      const res = await get(`/api/v1/${rcol}/_materialized/titles`, cookie);
      return res.status === 200 ? (await res.json()).result.data.items.map((i: any) => i.data.title) : [];
    };
    await until(async () => (await titles())[0] === "r2");
    await req("POST", `/api/v1/${rcol}/${id}/rollback/1`);
    await until(async () => (await titles())[0] === "r1", 2000);
  });
});
