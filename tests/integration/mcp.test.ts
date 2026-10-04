import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, signUp, signIn } from "../setup";

const email = `mcp+${Date.now()}@wren.dev`;
const col = `mcpdocs${Date.now()}`;
const tree = `mcpsite${Date.now()}`;
let key: string;
let slug: string;
let nextId = 1;

async function mcp(method: string, params?: unknown, opts: { auth?: string | null; path?: string; notify?: boolean } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const auth = opts.auth === undefined ? `Bearer ${key}` : opts.auth;
  if (auth) headers.Authorization = auth;
  const msg = opts.notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: nextId++, method, params };
  return fetch(`${BASE_URL}${opts.path ?? "/mcp"}`, { method: "POST", headers, body: JSON.stringify(msg) });
}
async function call(name: string, args: unknown, path?: string) {
  const res = await mcp("tools/call", { name, arguments: args }, { path });
  return (await res.json()).result as { content: { text: string }[]; isError?: boolean; structuredContent?: any };
}

beforeAll(async () => {
  await signUp(email, "secret123", "MCP Test");
  const { cookie } = await signIn(email, "secret123");
  key = (await (await post("/api/v1/keys", { name: "mcp" }, cookie)).json()).key;
  await fetch(`${BASE_URL}/api/v1/${col}/_schema`, {
    method: "PUT", headers: { "Content-Type": "application/json", Origin: BASE_URL, Cookie: cookie },
    body: JSON.stringify({ naturalKey: "slug", schema: { type: "object", required: ["slug"] } }),
  });
  await post("/api/v1/permissions", { principal: "*", resource: `tree:${tree}`, access: "read", labelFilter: "published" }, cookie);
});

describe("MCP endpoint", () => {
  it("requires a key", async () => {
    const res = await mcp("initialize", {}, { auth: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("initializes and negotiates the protocol version", async () => {
    const r = await (await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json();
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect(r.result.serverInfo.name).toBe("wren");
    expect(r.result.capabilities.tools).toBeDefined();
    expect((await mcp("notifications/initialized", undefined, { notify: true })).status).toBe(202);
  });

  it("lists tools with safety annotations; readonly hides writes", async () => {
    const all = (await (await mcp("tools/list")).json()).result.tools;
    const names = all.map((t: any) => t.name);
    expect(names).toContain("write_file");
    expect(all.find((t: any) => t.name === "promote_tree").annotations.destructiveHint).toBe(true);
    const ro = (await (await mcp("tools/list", {}, { path: "/mcp?readonly=1" })).json()).result.tools.map((t: any) => t.name);
    expect(ro).not.toContain("write_document");
    expect(ro).not.toContain("promote_tree");
    expect(ro).toContain("query_documents");
    const denied = await (await mcp("tools/call", { name: "write_document", arguments: { collection: col, data: {} } }, { path: "/mcp?readonly=1" })).json();
    expect(denied.error.code).toBe(-32602);
  });

  it("whoami reports the key's org and public URL patterns", async () => {
    const r = await call("whoami", {});
    slug = r.structuredContent.org.slug;
    expect(slug).toBeTruthy();
    expect(r.structuredContent.publicUrls.site).toBe(`/orgs/${slug}/tree/{tree}/{path}`);
  });

  it("write_document upserts by key and labels the version preview", async () => {
    const a = await call("write_document", { collection: col, key: "doc-1", data: { slug: "doc-1", n: 1 } });
    const b = await call("write_document", { collection: col, key: "doc-1", data: { slug: "doc-1", n: 2 } });
    expect(a.structuredContent.id).toBe(b.structuredContent.id);
    expect(b.structuredContent.version).toBe(2);
    expect(b.structuredContent.label).toBe("preview");
    const got = await call("get_document", { collection: col, key: "doc-1", label: "preview" });
    expect(got.structuredContent.data.n).toBe(2);
    const q = await call("query_documents", { collection: col, where: "slug:doc-1", select: ["n"] });
    expect(q.structuredContent.items).toHaveLength(1);
  });

  it("write_file + promote_tree releases a page atomically", async () => {
    const w = await call("write_file", { tree, path: "/index.html", content: "<h1>agent</h1>" });
    expect(w.isError).toBeUndefined();
    expect((await call("read_file", { tree, path: "/index.html", label: "preview" })).content[0].text).toBe("<h1>agent</h1>");
    expect((await fetch(`${BASE_URL}/orgs/${slug}/tree/${tree}/index.html`)).status).toBe(404);   // not promoted yet
    const p = await call("promote_tree", { tree });
    expect(p.content[0].text).toContain("one transaction");
    expect(await (await fetch(`${BASE_URL}/orgs/${slug}/tree/${tree}/index.html`)).text()).toBe("<h1>agent</h1>");
  });

  it("API errors come back as tool errors, unknown methods as JSON-RPC errors", async () => {
    const r = await call("get_document", { collection: col, id: "nope" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("404");
    const m = await (await mcp("resources/list")).json();
    expect(m.error.code).toBe(-32601);
  });

  it("GET is not supported (stateless endpoint)", async () => {
    expect((await fetch(`${BASE_URL}/mcp`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(405);
  });
});
