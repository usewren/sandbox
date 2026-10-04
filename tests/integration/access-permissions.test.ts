import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, call, account, invite, useOrg, groupIds, newKey, rule, db, until, type Account } from "./access-helpers";

// Permission rules: CRUD and validation, how checkAccess picks a rule, label and data
// filters, audit logging and public aliases.
const stamp = Date.now();
const tag = `perm${stamp}`;
let owner: Account, mia: Account, noah: Account, olga: Account;
let editors: string, viewers: string;
const col = `pcol${stamp}`;

beforeAll(async () => {
  owner = await account("owner", tag);
  mia = await account("mia", tag);     // member, groups vary per test
  noah = await account("noah", tag);   // member in no group at all
  olga = await account("olga", tag);   // never a member
  ({ editors, viewers } = await groupIds(owner));
  await invite(owner, mia, "member", [editors]);
  await invite(owner, noah, "member", []);
  await useOrg(mia, owner.id);
  await useOrg(noah, owner.id);
  await call("POST", `/api/v1/${col}`, { cookie: owner.cookie, body: { title: "seed", secret: "s" } });
});

describe("rule management", () => {
  it("rejects incomplete or malformed rules", async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ resource: "*" }, "principal is required"],
      [{ principal: "*" }, "resource is required"],
      [{ principal: "user:1", resource: "*" }, "principal must be"],
      [{ principal: "group:nope", resource: "*" }, "Unknown group"],
      [{ principal: "*", resource: "*", access: "owner" }, "access must be"],
      [{ principal: "*", resource: "*", filterLang: "xpath", filterExpr: "x" }, "filterLang must be"],
      [{ principal: "*", resource: "*", filterExpr: ".x" }, "filterLang is required"],
      [{ principal: "*", resource: `collection:${col}`, alias: "Bad_Alias" }, "Alias must be"],
      [{ principal: "*", resource: `collection:${col}`, alias: "keys" }, "reserved"],
    ];
    for (const [body, error] of bad) {
      const r = await rule(owner.cookie, body);
      expect(r.status).toBe(400);
      expect(r.json.error).toContain(error);
    }
  });

  it("a group from another org can't be named", async () => {
    const foreign = (await groupIds(olga)).editors;
    const r = await rule(owner.cookie, { principal: `group:${foreign}`, resource: "*", access: "write" });
    expect(r.status).toBe(400);
  });

  it("create, list, upsert on (principal, resource), update and delete", async () => {
    const resource = `collection:crud${stamp}`;
    const a = await rule(owner.cookie, { principal: `member:${mia.id}`, resource, access: "read", labelFilter: "published", auditReads: true });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ principal: `member:${mia.id}`, resource, access: "read", labelFilter: "published", auditReads: true, auditWrites: false, alias: null });

    // same principal + resource → the same rule, replaced
    const b = await rule(owner.cookie, { principal: `member:${mia.id}`, resource, access: "write" });
    expect(b.json.id).toBe(a.json.id);
    const listed = (await call("GET", "/api/v1/permissions", { cookie: owner.cookie })).json.permissions.find((p: any) => p.id === a.json.id);
    expect(listed).toMatchObject({ access: "write", labelFilter: null, auditReads: false });

    // update only touches the fields sent; null clears a filter
    const u1 = await call("PUT", `/api/v1/permissions/${a.json.id}`, { cookie: owner.cookie, body: { labelFilter: "published", filterLang: "jq", filterExpr: "{title}", auditWrites: true } });
    expect(u1.status).toBe(200);
    expect(u1.json).toMatchObject({ access: "write", labelFilter: "published", filterLang: "jq", filterExpr: "{title}", auditWrites: true, auditReads: false });
    const u2 = await call("PUT", `/api/v1/permissions/${a.json.id}`, { cookie: owner.cookie, body: { access: "read", labelFilter: null } });
    expect(u2.json).toMatchObject({ access: "read", labelFilter: null, filterLang: "jq", filterExpr: "{title}" });

    expect((await call("PUT", `/api/v1/permissions/${a.json.id}`, { cookie: owner.cookie, body: { access: "everything" } })).status).toBe(400);
    expect((await call("PUT", `/api/v1/permissions/${a.json.id}`, { cookie: owner.cookie, body: { filterLang: "sql" } })).status).toBe(400);
    expect((await call("PUT", `/api/v1/permissions/no-such-rule`, { cookie: owner.cookie, body: { access: "read" } })).status).toBe(404);

    const del = await call("DELETE", `/api/v1/permissions/${a.json.id}`, { cookie: owner.cookie });
    expect(del.json).toEqual({ id: a.json.id, deleted: true });
    expect((await call("DELETE", `/api/v1/permissions/${a.json.id}`, { cookie: owner.cookie })).status).toBe(404);
  });

  it("rules of one org can't be changed or deleted from another", async () => {
    const mine = await rule(owner.cookie, { principal: "*", resource: `collection:iso${stamp}`, access: "read" });
    expect((await call("PUT", `/api/v1/permissions/${mine.json.id}`, { cookie: olga.cookie, body: { access: "write" } })).status).toBe(404);
    expect((await call("DELETE", `/api/v1/permissions/${mine.json.id}`, { cookie: olga.cookie })).status).toBe(404);
    const olgasList = (await call("GET", "/api/v1/permissions", { cookie: olga.cookie })).json.permissions;
    expect(olgasList.some((p: any) => p.id === mine.json.id)).toBe(false);
    await call("DELETE", `/api/v1/permissions/${mine.json.id}`, { cookie: owner.cookie });
  });

  it("members (not admins) can't list or manage rules", async () => {
    expect((await call("GET", "/api/v1/permissions", { cookie: mia.cookie })).status).toBe(403);
    expect((await rule(mia.cookie, { principal: `member:${mia.id}`, resource: "*", access: "admin" })).status).toBe(403);
    expect((await call("PUT", "/api/v1/permissions/x", { cookie: mia.cookie, body: {} })).status).toBe(403);
    expect((await call("DELETE", "/api/v1/permissions/x", { cookie: mia.cookie })).status).toBe(403);
  });

  it("only GET, POST, PUT and DELETE are routed", async () => {
    expect((await call("GET", "/api/v1/permissions/some-id", { cookie: owner.cookie })).status).toBe(405);
    expect((await call("PUT", "/api/v1/permissions", { cookie: owner.cookie, body: {} })).status).toBe(405);
  });
});

describe("which rule applies", () => {
  it("deny by default: a member in no group gets nothing", async () => {
    expect((await call("GET", `/api/v1/${col}`, { cookie: noah.cookie })).status).toBe(403);
    expect((await call("POST", `/api/v1/${col}`, { cookie: noah.cookie, body: {} })).status).toBe(403);
    const me = (await call("GET", "/api/v1/me", { cookie: noah.cookie })).json;
    expect(me.org).toMatchObject({ id: owner.id, role: "member" });
    expect(me.groups).toEqual([]);
  });

  it("the most specific resource wins: collection:x over collection:* over *", async () => {
    const x = `spec${stamp}`, y = `specy${stamp}`, t = `spect${stamp}`;
    await rule(owner.cookie, { principal: `member:${noah.id}`, resource: "*", access: "write" });
    await rule(owner.cookie, { principal: `member:${noah.id}`, resource: "collection:*", access: "read" });
    await rule(owner.cookie, { principal: `member:${noah.id}`, resource: `collection:${x}`, access: "write" });
    expect((await call("POST", `/api/v1/${x}`, { cookie: noah.cookie, body: { n: 1 } })).status).toBe(201);   // collection:x write
    expect((await call("POST", `/api/v1/${y}`, { cookie: noah.cookie, body: { n: 1 } })).status).toBe(403);   // collection:* read
    expect((await call("GET", `/api/v1/${y}`, { cookie: noah.cookie })).status).toBe(200);
    const doc = (await call("POST", `/api/v1/${x}`, { cookie: noah.cookie, body: { n: 2 } })).json.id;
    expect((await call("PUT", `/api/v1/tree/${t}/a.html`, { cookie: noah.cookie, body: { documentId: doc } })).status).toBeLessThan(300); // trees fall to * write
    const me = (await call("GET", "/api/v1/me", { cookie: noah.cookie })).json;
    expect(me.permissions.map((p: any) => p.resource).sort()).toEqual(expect.arrayContaining(["*", "collection:*", `collection:${x}`]));
  });

  it("a personal rule beats a group rule on the same resource", async () => {
    const c = `pers${stamp}`;
    const team = (await call("POST", "/api/v1/groups", { cookie: owner.cookie, body: { name: `writers-${stamp}` } })).json.id;
    await call("PUT", `/api/v1/groups/${team}/members/${mia.id}`, { cookie: owner.cookie });
    await rule(owner.cookie, { principal: `group:${team}`, resource: `collection:${c}`, access: "write" });
    await rule(owner.cookie, { principal: `member:${mia.id}`, resource: `collection:${c}`, access: "read" });
    expect((await call("GET", `/api/v1/${c}`, { cookie: mia.cookie })).status).toBe(200);
    expect((await call("POST", `/api/v1/${c}`, { cookie: mia.cookie, body: {} })).status).toBe(403);
  });

  it("a personal 'none' on one collection blocks it despite Editors", async () => {
    const c = `blocked${stamp}`;
    await rule(owner.cookie, { principal: `member:${mia.id}`, resource: `collection:${c}`, access: "none" });
    expect((await call("GET", `/api/v1/${c}`, { cookie: mia.cookie })).status).toBe(403);
    expect((await call("GET", `/api/v1/${col}`, { cookie: mia.cookie })).status).toBe(200);   // Editors still apply elsewhere
  });

  it("among groups the highest access wins", async () => {
    const c = `hi${stamp}`;
    const readers = (await call("POST", "/api/v1/groups", { cookie: owner.cookie, body: { name: `readers-${stamp}` } })).json.id;
    const writers = (await call("POST", "/api/v1/groups", { cookie: owner.cookie, body: { name: `admins-${stamp}` } })).json.id;
    await rule(owner.cookie, { principal: `group:${readers}`, resource: `collection:${c}`, access: "read" });
    await rule(owner.cookie, { principal: `group:${writers}`, resource: `collection:${c}`, access: "admin" });
    const p = await account("pia", tag);
    await invite(owner, p, "member", [readers, writers]);
    await useOrg(p, owner.id);
    // admin access is needed to change a collection's schema
    const s = await call("PUT", `/api/v1/${c}/_schema`, { cookie: p.cookie, body: { schema: { type: "object" } } });
    expect(s.status).toBeLessThan(300);
  });

  it("the owner bypasses every rule, even one naming them", async () => {
    const c = `own${stamp}`;
    await rule(owner.cookie, { principal: `member:${owner.id}`, resource: `collection:${c}`, access: "none" });
    expect((await call("POST", `/api/v1/${c}`, { cookie: owner.cookie, body: { ok: true } })).status).toBe(201);
  });

  it("someone who isn't a member gets nothing, even with a personal rule", async () => {
    const c = `nm${stamp}`;
    const r = await account("rex", tag);
    await invite(owner, r, "member", []);
    await useOrg(r, owner.id);
    await rule(owner.cookie, { principal: `member:${r.id}`, resource: `collection:${c}`, access: "write" });
    expect((await call("POST", `/api/v1/${c}`, { cookie: r.cookie, body: {} })).status).toBe(201);
    await call("DELETE", `/api/v1/members/${r.id}`, { cookie: owner.cookie });
    // the session still points at the org, but the rule no longer applies
    expect((await call("POST", `/api/v1/${c}`, { cookie: r.cookie, body: {} })).status).toBe(403);
    expect((await call("GET", `/api/v1/${c}`, { cookie: r.cookie })).status).toBe(403);
    // and switching back in is refused
    expect((await useOrg(r, owner.id)).status).toBe(403);
    // a stranger can't switch into the org at all
    expect((await useOrg(olga, owner.id)).status).toBe(403);
  });
});

describe("label filters", () => {
  const c = `lab${stamp}`;
  let id: string;
  let lf: Account;

  beforeAll(async () => {
    lf = await account("lena", tag);
    await invite(owner, lf, "member", []);
    await useOrg(lf, owner.id);
    id = (await call("POST", `/api/v1/${c}`, { cookie: owner.cookie, body: { title: "v1-published" } })).json.id;
    await call("POST", `/api/v1/${c}/${id}/labels`, { cookie: owner.cookie, body: { label: "published" } });
    await call("PUT", `/api/v1/${c}/${id}`, { cookie: owner.cookie, body: { title: "v2-draft" } });
    await call("POST", `/api/v1/${c}`, { cookie: owner.cookie, body: { title: "never-published" } });
    await rule(owner.cookie, { principal: `member:${lf.id}`, resource: `collection:${c}`, access: "read", labelFilter: "published" });
  });

  it("a member's list, get and by-id reads see only the labelled version", async () => {
    for (const q of ["", "?label=", "?label=draft", "?label=latest"]) {
      const list = (await call("GET", `/api/v1/${c}${q}`, { cookie: lf.cookie })).json;
      expect(list.items.map((i: any) => i.data.title)).toEqual(["v1-published"]);
    }
    const one = await call("GET", `/api/v1/${c}/${id}?label=draft`, { cookie: lf.cookie });
    expect(one.json.data.title).toBe("v1-published");
    expect(one.json.version).toBe(1);
  });

  it("the owner still sees the latest version", async () => {
    const one = await call("GET", `/api/v1/${c}/${id}`, { cookie: owner.cookie });
    expect(one.json.data.title).toBe("v2-draft");
  });

  it("fixed: version history reads ignore the rule's label filter", async () => {
    // GET /{collection}/{id}/versions/{n} and /diff return unpublished versions to a
    // reader whose rule only allows the published label.
    const v2 = await call("GET", `/api/v1/${c}/${id}/versions/2`, { cookie: lf.cookie });
    expect(v2.status).not.toBe(200);
    const diff = await call("GET", `/api/v1/${c}/${id}/diff?v1=1&v2=2`, { cookie: lf.cookie });
    expect(JSON.stringify(diff.json)).not.toContain("v2-draft");
  });
});

describe("data filters", () => {
  const c = `filt${stamp}`;
  let id: string;
  let fx: Account;

  beforeAll(async () => {
    fx = await account("felix", tag);
    await invite(owner, fx, "member", []);
    await useOrg(fx, owner.id);
    id = (await call("POST", `/api/v1/${c}`, { cookie: owner.cookie, body: { title: "Hello", salary: 100, tags: ["a"] } })).json.id;
  });

  async function readAs(filterLang: string, filterExpr: string) {
    await rule(owner.cookie, { principal: `member:${fx.id}`, resource: `collection:${c}`, access: "read", filterLang, filterExpr });
    const list = (await call("GET", `/api/v1/${c}`, { cookie: fx.cookie })).json;
    const one = (await call("GET", `/api/v1/${c}/${id}`, { cookie: fx.cookie })).json;
    return { list: list.items[0].data, one: one.data };
  }

  it("jq", async () => {
    const r = await readAs("jq", "{title}");
    expect(r.list).toEqual({ title: "Hello" });
    expect(r.one).toEqual({ title: "Hello" });
  });

  it("JMESPath", async () => {
    const r = await readAs("jmespath", "{name: title, n: salary}");
    expect(r.one).toEqual({ name: "Hello", n: 100 });
  });

  it("JSONata", async () => {
    const r = await readAs("jsonata", `{"upper": $uppercase(title)}`);
    expect(r.one).toEqual({ upper: "HELLO" });
    expect(r.list).toEqual({ upper: "HELLO" });
  });

  it("a filter that doesn't compile is refused when the rule is saved", async () => {
    for (const [filterLang, filterExpr] of [["jq", "this is not jq"], ["jmespath", "a[?"], ["jsonata", "$.(("]]) {
      const r = await call("POST", "/api/v1/permissions", { cookie: owner.cookie, body: { principal: `member:${fx.id}`, resource: `collection:${c}`, access: "read", filterLang, filterExpr } });
      expect(r.status).toBe(400);
      expect(r.json.error).toContain(`not valid ${filterLang}`);
    }
  });

  it("a filter that fails at runtime hides the data instead of leaking it", async () => {
    const r = await readAs("jq", 'error("boom")');
    expect(r.one).toBeNull();
  });

  it("filters also apply to a member's _query results", async () => {
    await rule(owner.cookie, { principal: `member:${fx.id}`, resource: `collection:${c}`, access: "read", filterLang: "jmespath", filterExpr: "{title: title}" });
    const q = await call("POST", `/api/v1/${c}/_query`, { cookie: fx.cookie, body: {} });
    expect(q.status).toBe(200);
    expect(JSON.stringify(q.json)).not.toContain("salary");
  });

  it("filters apply on public reads too", async () => {
    const pub = `pubfilt${stamp}`;
    const pid = (await call("POST", `/api/v1/${pub}`, { cookie: owner.cookie, body: { title: "Public", email: "x@y.z" } })).json.id;
    await rule(owner.cookie, { principal: "*", resource: `collection:${pub}`, access: "read", filterLang: "jq", filterExpr: "{title}" });
    const list = await call("GET", `/api/v1/orgs/${owner.slug}/${pub}`, { origin: null });
    expect(list.json.items[0].data).toEqual({ title: "Public" });
    const one = await call("GET", `/api/v1/orgs/${owner.slug}/${pub}/${pid}`, { origin: null });
    expect(one.json.data).toEqual({ title: "Public" });
    const txt = await (await fetch(`${BASE_URL}/orgs/${owner.slug}/llms.txt`)).text();
    expect(txt).toContain("Public");
    expect(txt).not.toContain("x@y.z");
  });
});

describe("audit log", () => {
  const c = `aud${stamp}`;
  const logged = (principal: string, method: string, status: number) => until(async () =>
    (await db()`SELECT 1 FROM common.access_log WHERE org_id = ${owner.id} AND principal = ${principal}
                AND resource = ${"collection:" + c} AND method = ${method} AND status = ${status}`).length > 0, 3000);

  it("audited reads and denied writes are logged; unaudited ones are not", async () => {
    const au = await account("audrey", tag);
    await invite(owner, au, "member", []);
    await useOrg(au, owner.id);
    await rule(owner.cookie, { principal: `member:${au.id}`, resource: `collection:${c}`, access: "read", auditReads: true, auditWrites: true });
    expect((await call("GET", `/api/v1/${c}`, { cookie: au.cookie })).status).toBe(200);
    expect((await call("POST", `/api/v1/${c}`, { cookie: au.cookie, body: {} })).status).toBe(403);
    expect(await logged(`member:${au.id}`, "GET", 200)).toBe(true);
    expect(await logged(`member:${au.id}`, "POST", 403)).toBe(true);
  });

  it("audited writes are logged with the key as principal", async () => {
    const ak = await account("arno", tag);
    await invite(owner, ak, "member", []);
    await useOrg(ak, owner.id);
    const k = await newKey(ak.cookie, "audited");
    await rule(owner.cookie, { principal: `key:${k.id}`, resource: `collection:${c}`, access: "write", auditWrites: true });
    expect((await call("POST", `/api/v1/${c}`, { key: k.key, body: { by: "key" } })).status).toBe(201);
    expect(await logged(`key:${k.id}`, "POST", 201)).toBe(true);
    // reads aren't audited on this rule
    await call("GET", `/api/v1/${c}`, { key: k.key });
    await Bun.sleep(200);
    expect((await db()`SELECT 1 FROM common.access_log WHERE principal = ${"key:" + k.id} AND method = 'GET'`).length).toBe(0);
  });
});

describe("public aliases", () => {
  const c = `aliased${stamp}`;
  const alias = `news-${stamp}`;
  let id: string;

  beforeAll(async () => {
    id = (await call("POST", `/api/v1/${c}`, { cookie: owner.cookie, body: { title: "via alias" } })).json.id;
  });

  it("a public rule's alias serves the collection under a short name", async () => {
    const r = await rule(owner.cookie, { principal: "*", resource: `collection:${c}`, access: "read", alias });
    expect(r.json.alias).toBe(alias);
    const list = await call("GET", `/orgs/${owner.slug}/${alias}`, { origin: null });
    expect(list.json.items.map((i: any) => i.data.title)).toEqual(["via alias"]);
    const one = await call("GET", `/api/v1/orgs/${owner.slug}/${alias}/${id}`, { origin: null });
    expect(one.json.data.title).toBe("via alias");
    expect((await call("GET", "/api/v1/permissions", { cookie: owner.cookie })).json.permissions.find((p: any) => p.id === r.json.id).alias).toBe(alias);
  });

  it("an alias on a non-public rule doesn't open anything", async () => {
    const hidden = `hid${stamp}`;
    await call("POST", `/api/v1/${hidden}`, { cookie: owner.cookie, body: { secret: true } });
    await rule(owner.cookie, { principal: `member:${mia.id}`, resource: `collection:${hidden}`, access: "read", alias: `hid-${stamp}` });
    expect((await call("GET", `/orgs/${owner.slug}/hid-${stamp}`, { origin: null })).status).toBe(403);
  });

  it("a tree alias serves the site root", async () => {
    const tree = `atree${stamp}`;
    const doc = (await call("POST", `/api/v1/apages${stamp}`, { cookie: owner.cookie, body: { title: "root" } })).json.id;
    await call("PUT", `/api/v1/tree/${tree}/`, { cookie: owner.cookie, body: { documentId: doc } });
    await rule(owner.cookie, { principal: "*", resource: `tree:${tree}`, access: "read", alias: `site-${stamp}` });
    const r = await call("GET", `/api/v1/orgs/${owner.slug}/site-${stamp}`, { origin: null });
    expect(r.status).toBe(200);
    expect(r.text).toContain("root");
  });

  it("fixed: a tree alias ignores the path and always serves the root", async () => {
    const tree = `btree${stamp}`;
    const home = (await call("POST", `/api/v1/bpages${stamp}`, { cookie: owner.cookie, body: { title: "home" } })).json.id;
    const about = (await call("POST", `/api/v1/bpages${stamp}`, { cookie: owner.cookie, body: { title: "about-page" } })).json.id;
    await call("PUT", `/api/v1/tree/${tree}/`, { cookie: owner.cookie, body: { documentId: home } });
    await call("PUT", `/api/v1/tree/${tree}/about`, { cookie: owner.cookie, body: { documentId: about } });
    await rule(owner.cookie, { principal: "*", resource: `tree:${tree}`, access: "read", alias: `bsite-${stamp}` });
    const direct = await call("GET", `/orgs/${owner.slug}/tree/${tree}/about`, { origin: null });
    expect(direct.text).toContain("about-page");
    const viaAlias = await call("GET", `/orgs/${owner.slug}/bsite-${stamp}/about`, { origin: null });
    expect(viaAlias.text).toContain("about-page");
  });

  it("fixed: a duplicate alias is a server error instead of a 409", async () => {
    const other = `dup${stamp}`;
    const r = await rule(owner.cookie, { principal: "*", resource: `collection:${other}`, access: "read", alias });
    expect(r.status).toBe(409);
  });
});
