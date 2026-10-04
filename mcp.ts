// MCP (Model Context Protocol) endpoint: POST /mcp
//
// One endpoint per WREN instance. The org comes from the caller's API key (or
// session), exactly like the REST API, so an agent sees and changes only what its
// key may. Every tool calls the REST API in-process through `dispatch`, which means
// permissions, label filters and org scoping are enforced by the same code paths.
//
// Transport: MCP Streamable HTTP in its stateless JSON form (no SSE stream, no
// session id). GET/DELETE return 405. `?readonly=1` exposes only read tools.

type Json = Record<string, unknown>;
type Dispatch = (req: Request) => Promise<Response>;

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_TEXT_FILE = 256 * 1024;

const INSTRUCTIONS = `WREN is a versioned JSON store that also serves static sites.
- Every write creates a new immutable version; nothing is overwritten.
- Labels (e.g. "preview", "published") are per-document pointers to versions.
- Trees map URL paths to documents; public visitors usually see the "published" label.
Safe workflow: write documents/files with label "preview" (the default here), check them with
get_document/read_file using label "preview", then ask the user before calling promote_tree,
which makes a whole tree's "preview" versions live in one transaction.
Use write_document with a natural key to update instead of creating duplicates.`;

// ── Tool definitions ─────────────────────────────────────────────────────────

type Tool = {
  name: string; title: string; description: string; readOnly: boolean; destructive?: boolean;
  inputSchema: Json;
  run: (args: Json, api: Api) => Promise<ToolResult>;
};
type ToolResult = { text: string; data?: unknown; isError?: boolean };
type Api = (method: string, path: string, body?: unknown, opts?: { accept?: string; form?: FormData }) => Promise<{ status: number; ok: boolean; json?: unknown; text?: string; contentType: string; bytes?: Uint8Array }>;

const str = (description: string) => ({ type: "string", description });
const enc = (s: string) => encodeURIComponent(s);
const treePath = (p: string) => "/" + String(p).replace(/^\/+/, "").split("/").map(enc).join("/");

function apiError(r: { status: number; json?: unknown; text?: string }): ToolResult {
  const msg = (r.json as Json | undefined)?.error ?? r.text ?? "request failed";
  return { text: `WREN returned ${r.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, isError: true };
}
const ok = (data: unknown, summary?: string): ToolResult =>
  ({ text: (summary ? summary + "\n" : "") + JSON.stringify(data, null, 2), data });

async function labelVersion(api: Api, collection: string, id: string, label: string, version?: number) {
  const r = await api("POST", `/api/v1/${enc(collection)}/${enc(id)}/labels`, version ? { label, version } : { label });
  return r.ok ? null : apiError(r);
}

const TOOLS: Tool[] = [
  {
    name: "whoami", title: "Who am I", readOnly: true,
    description: "Show the org this key acts in (id, name, slug), your role and permission rules, and the URL patterns for public access.",
    inputSchema: { type: "object", properties: {} },
    async run(_a, api) {
      const r = await api("GET", "/api/v1/me");
      if (!r.ok) return apiError(r);
      const slug = ((r.json as Json).org as Json | undefined)?.slug;
      return ok({
        ...(r.json as Json),
        publicUrls: slug ? {
          site: `/orgs/${slug}/tree/{tree}/{path}`,
          data: `/api/v1/orgs/${slug}/{collection}`,
          note: "Public URLs work only for trees/collections with a principal '*' read rule.",
        } : undefined,
      });
    },
  },
  {
    name: "list_collections", title: "List collections", readOnly: true,
    description: "List the collections in this org.",
    inputSchema: { type: "object", properties: {} },
    async run(_a, api) {
      const r = await api("GET", "/api/v1/collections");
      return r.ok ? ok(r.json) : apiError(r);
    },
  },
  {
    name: "query_documents", title: "Query documents", readOnly: true,
    description: "Find documents in a collection. Supports filtering (where), projection (select), aggregation, a label (e.g. \"published\") and cursor paging (max 1000 per page).",
    inputSchema: {
      type: "object", required: ["collection"],
      properties: {
        collection: str("Collection name"),
        where: str("Filter, e.g. \"country:SUI AND year>=2024\". Operators : = != > >= < <= ~* !~* @>"),
        select: { type: "array", items: { type: "string" }, description: "Fields to return, e.g. [\"name\",\"date\"]" },
        label: str("Return the version carrying this label instead of the latest"),
        aggregate: { type: "object", description: "e.g. {\"groupBy\":[\"country\"],\"metrics\":{\"n\":{\"count\":\"name\"}}}" },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 50 },
        cursor: str("Cursor from the previous page"),
      },
    },
    async run(a, api) {
      const body: Json = { limit: a.limit ?? 50 };
      for (const k of ["where", "select", "label", "aggregate", "cursor"]) if (a[k] !== undefined) body[k] = a[k];
      const r = await api("POST", `/api/v1/${enc(String(a.collection))}/_query`, body);
      return r.ok ? ok(r.json) : apiError(r);
    },
  },
  {
    name: "get_document", title: "Get a document", readOnly: true,
    description: "Read one document by id or by natural key. Optionally at a label (\"preview\", \"published\") or a specific version number.",
    inputSchema: {
      type: "object", required: ["collection"],
      properties: {
        collection: str("Collection name"), id: str("Document id"), key: str("Natural key value (if the collection declares one)"),
        label: str("Label to read through"), version: { type: "integer", minimum: 1, description: "Exact version number (needs id)" },
      },
    },
    async run(a, api) {
      const c = enc(String(a.collection));
      if (!a.id && !a.key) return { text: "Provide id or key.", isError: true };
      if (a.version !== undefined && !a.id) return { text: "version needs id.", isError: true };
      const qs = a.label ? `?label=${enc(String(a.label))}` : "";
      const path = a.version !== undefined ? `/api/v1/${c}/${enc(String(a.id))}/versions/${Number(a.version)}`
        : a.id ? `/api/v1/${c}/${enc(String(a.id))}${qs}` : `/api/v1/${c}/by-key/${enc(String(a.key))}${qs}`;
      const r = await api("GET", path);
      return r.ok ? ok(r.json) : apiError(r);
    },
  },
  {
    name: "list_versions", title: "List versions", readOnly: true,
    description: "List the version history of a document.",
    inputSchema: { type: "object", required: ["collection", "id"], properties: { collection: str("Collection name"), id: str("Document id") } },
    async run(a, api) {
      const r = await api("GET", `/api/v1/${enc(String(a.collection))}/${enc(String(a.id))}/versions`);
      return r.ok ? ok(r.json) : apiError(r);
    },
  },
  {
    name: "diff_versions", title: "Diff two versions", readOnly: true,
    description: "Show what changed between two versions of a document.",
    inputSchema: {
      type: "object", required: ["collection", "id", "v1", "v2"],
      properties: { collection: str("Collection name"), id: str("Document id"), v1: { type: "integer", minimum: 1 }, v2: { type: "integer", minimum: 1 } },
    },
    async run(a, api) {
      const r = await api("GET", `/api/v1/${enc(String(a.collection))}/${enc(String(a.id))}/diff?v1=${Number(a.v1)}&v2=${Number(a.v2)}`);
      return r.ok ? ok(r.json) : apiError(r);
    },
  },
  {
    name: "list_tree", title: "List a tree", readOnly: true,
    description: "Without a tree name: list all trees. With a tree name: list every path in it with its document id and collection.",
    inputSchema: { type: "object", properties: { tree: str("Tree name"), label: str("Resolve documents at this label") } },
    async run(a, api) {
      if (!a.tree) { const r = await api("GET", "/api/v1/tree"); return r.ok ? ok(r.json) : apiError(r); }
      const qs = `?full=true${a.label ? `&label=${enc(String(a.label))}` : ""}`;
      const r = await api("GET", `/api/v1/tree/${enc(String(a.tree))}${qs}`);
      return r.ok ? ok(r.json) : apiError(r);
    },
  },
  {
    name: "read_file", title: "Read a file from a tree", readOnly: true,
    description: "Read the content of a file (HTML, CSS, JS, JSON, text) at a tree path, optionally at a label such as \"preview\". Binary files return metadata only.",
    inputSchema: { type: "object", required: ["tree", "path"], properties: { tree: str("Tree name"), path: str("Path, e.g. /index.html"), label: str("Label to read through") } },
    async run(a, api) {
      const qs = a.label ? `?label=${enc(String(a.label))}` : "";
      const r = await api("GET", `/api/v1/tree/${enc(String(a.tree))}${treePath(String(a.path))}${qs}`, undefined, { accept: "*/*" });
      if (!r.ok) return apiError(r);
      const textual = /^(text\/|application\/(json|javascript|xml|.*\+json|.*\+xml))|image\/svg/.test(r.contentType);
      if (!textual || !r.bytes) return ok({ contentType: r.contentType, size: r.bytes?.byteLength, note: "binary file: content not returned" });
      if (r.bytes.byteLength > MAX_TEXT_FILE) return ok({ contentType: r.contentType, size: r.bytes.byteLength, note: `larger than ${MAX_TEXT_FILE} bytes: content not returned` });
      return { text: new TextDecoder().decode(r.bytes) };
    },
  },
  {
    name: "write_document", title: "Write a document", readOnly: false,
    description: "Create or update a JSON document. With key: upsert by natural key (no duplicates). With id: new version of that document. Neither: create a new document. The new version gets the label \"preview\" unless you pass another label (or \"\" for none). If the collection's public rule has no label filter, visitors see the latest version immediately.",
    inputSchema: {
      type: "object", required: ["collection", "data"],
      properties: {
        collection: str("Collection name"), data: { type: "object", description: "The full document (replaces the previous version's data)" },
        key: str("Natural key value for an upsert"), id: str("Existing document id"),
        label: { type: "string", default: "preview", description: "Label for the new version; \"\" for none" },
      },
    },
    async run(a, api) {
      const c = enc(String(a.collection));
      const r = a.key ? await api("PUT", `/api/v1/${c}/by-key/${enc(String(a.key))}`, a.data)
        : a.id ? await api("PUT", `/api/v1/${c}/${enc(String(a.id))}`, a.data)
        : await api("POST", `/api/v1/${c}`, a.data);
      if (!r.ok) return apiError(r);
      const doc = r.json as { id: string; version: number };
      const label = a.label === undefined ? "preview" : String(a.label);
      if (label) { const e = await labelVersion(api, String(a.collection), doc.id, label, doc.version); if (e) return e; }
      return ok({ id: doc.id, version: doc.version, label: label || null }, `Wrote ${a.collection}/${doc.id} v${doc.version}${label ? ` (label "${label}")` : ""}.`);
    },
  },
  {
    name: "write_file", title: "Write a file into a tree", readOnly: false,
    description: "Write a file at a tree path (e.g. /index.html). Updates the existing file as a new version, or creates it in the tree's asset collection. Labels the new version \"preview\" by default; use promote_tree to publish.",
    inputSchema: {
      type: "object", required: ["tree", "path", "content"],
      properties: {
        tree: str("Tree name"), path: str("Path, e.g. /index.html"), content: str("File content"),
        encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8" },
        contentType: str("MIME type, e.g. text/html (guessed from the extension if omitted)"),
        collection: str("Asset collection for new files (default: <tree>-assets)"),
        label: { type: "string", default: "preview", description: "Label for the new version; \"\" for none" },
      },
    },
    async run(a, api) {
      const tree = String(a.tree), p = treePath(String(a.path));
      const name = decodeURIComponent(p.split("/").pop() || "index.html");
      const bytes = a.encoding === "base64" ? Uint8Array.from(atob(String(a.content)), ch => ch.charCodeAt(0)) : new TextEncoder().encode(String(a.content));
      const type = String(a.contentType ?? guessType(name));
      const form = new FormData();
      form.append("file", new File([bytes], name, { type }));

      const node = await api("GET", `/api/v1/tree/${enc(tree)}${p}`, undefined, { accept: "application/json" });
      const existing = node.ok ? ((node.json as Json).document as { id: string; collection: string } | null) : null;
      let doc: { id: string; version: number }, collection: string;
      if (existing?.id) {
        collection = existing.collection;
        const r = await api("PUT", `/api/v1/${enc(collection)}/${enc(existing.id)}`, undefined, { form });
        if (!r.ok) return apiError(r);
        doc = r.json as typeof doc;
      } else {
        collection = String(a.collection ?? `${tree}-assets`);
        const r = await api("POST", `/api/v1/${enc(collection)}`, undefined, { form });
        if (!r.ok) return apiError(r);
        doc = r.json as typeof doc;
        const t = await api("PUT", `/api/v1/tree/${enc(tree)}${p}`, { documentId: doc.id });
        if (!t.ok) return apiError(t);
      }
      const label = a.label === undefined ? "preview" : String(a.label);
      if (label) { const e = await labelVersion(api, collection, doc.id, label, doc.version); if (e) return e; }
      return ok({ tree, path: p, collection, id: doc.id, version: doc.version, label: label || null },
        `Wrote ${tree}${p} (v${doc.version}${label ? `, label "${label}"` : ""}).`);
    },
  },
  {
    name: "set_label", title: "Set a label", readOnly: false, destructive: true,
    description: "Point a label at a version of one document (default: its latest). Setting \"published\" makes that version public if the public rule filters on it, so confirm with the user first.",
    inputSchema: {
      type: "object", required: ["collection", "id", "label"],
      properties: { collection: str("Collection name"), id: str("Document id"), label: str("Label name"), version: { type: "integer", minimum: 1 } },
    },
    async run(a, api) {
      const e = await labelVersion(api, String(a.collection), String(a.id), String(a.label), a.version as number | undefined);
      return e ?? ok({ collection: a.collection, id: a.id, label: a.label, version: a.version ?? "latest" }, "Label set.");
    },
  },
  {
    name: "promote_tree", title: "Promote a tree", readOnly: false, destructive: true,
    description: "Release a tree: move a label (default \"published\") to the version carrying `from` (default \"preview\") for every document in the tree, in ONE transaction. This is what makes changes live for visitors. Confirm with the user before calling. Roll back by promoting an older release label.",
    inputSchema: {
      type: "object", required: ["tree"],
      properties: { tree: str("Tree name"), from: { type: "string", default: "preview" }, label: { type: "string", default: "published" } },
    },
    async run(a, api) {
      const r = await api("POST", `/api/v1/tree/${enc(String(a.tree))}/_promote`, { from: a.from ?? "preview", label: a.label ?? "published" });
      if (!r.ok) return apiError(r);
      const n = ((r.json as Json).promoted as unknown[]).length;
      return ok(r.json, `Promoted ${n} document(s) in tree "${a.tree}" to "${a.label ?? "published"}" in one transaction.`);
    },
  },
];

function guessType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return ({
    html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
    json: "application/json", svg: "image/svg+xml", txt: "text/plain", md: "text/markdown", xml: "application/xml",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", pdf: "application/pdf",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

// ── JSON-RPC / MCP handling ─────────────────────────────────────────────────

type RpcReq = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };
const rpcResult = (id: RpcReq["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcReq["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export async function handleMcp(req: Request, url: URL, dispatch: Dispatch, version: string): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify(rpcError(null, -32000, "This MCP endpoint is stateless: send JSON-RPC with POST")), {
      status: 405, headers: { "Content-Type": "application/json", Allow: "POST" },
    });
  }
  const readonly = url.searchParams.get("readonly") === "1" || url.searchParams.get("readonly") === "true";
  const tools = TOOLS.filter(t => !readonly || t.readOnly);

  // Forward only the caller's credentials to the in-process API calls.
  const auth: Record<string, string> = {};
  const authz = req.headers.get("authorization"); if (authz) auth["Authorization"] = authz;
  const cookie = req.headers.get("cookie"); if (cookie) auth["Cookie"] = cookie;
  const origin = new URL(req.url).origin;

  const api: Api = async (method, path, body, opts = {}) => {
    const headers: Record<string, string> = { ...auth, Accept: opts.accept ?? "application/json", Origin: origin };
    let payload: BodyInit | undefined;
    if (opts.form) payload = opts.form;
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await dispatch(new Request(origin + path, { method, headers, body: payload }));
    const contentType = res.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    let json: unknown; let text: string | undefined;
    if (contentType.includes("json")) { try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* not JSON */ } }
    else text = new TextDecoder().decode(bytes.slice(0, 2000));
    return { status: res.status, ok: res.ok, json, text, contentType, bytes };
  };

  // Credentials are required up front so clients get a clear 401 instead of tool errors.
  const me = await api("GET", "/api/v1/me");
  if (me.status === 401) {
    return new Response(JSON.stringify(rpcError(null, -32001, "Unauthorized: send Authorization: Bearer wren_… (a WREN API key)")), {
      status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer realm="wren"' },
    });
  }

  let body: unknown;
  try { body = await req.json(); } catch { return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 }); }
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcReq[];

  const out: unknown[] = [];
  for (const m of msgs) {
    const isNotification = m.id === undefined || m.id === null;
    const reply = await handleMessage(m, tools, api, version, readonly);
    if (!isNotification && reply) out.push(reply);
  }
  if (out.length === 0) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0], { headers: { "Cache-Control": "no-store" } });
}

async function handleMessage(m: RpcReq, tools: Tool[], api: Api, version: string, readonly: boolean): Promise<unknown> {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(m?.id, -32600, "Invalid request");
  switch (m.method) {
    case "initialize": {
      const requested = String(m.params?.protocolVersion ?? "");
      return rpcResult(m.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wren", title: "WREN", version },
        instructions: INSTRUCTIONS + (readonly ? "\nThis connection is read-only." : ""),
      });
    }
    case "ping":
      return rpcResult(m.id, {});
    case "tools/list":
      return rpcResult(m.id, {
        tools: tools.map(t => ({
          name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: !!t.destructive, idempotentHint: t.readOnly, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      const tool = tools.find(t => t.name === name);
      if (!tool) return rpcError(m.id, -32602, `Unknown tool: ${name}${readonly ? " (read-only connection)" : ""}`);
      const args = (m.params?.arguments ?? {}) as Json;
      const missing = ((tool.inputSchema.required ?? []) as string[]).filter(k => args[k] === undefined || args[k] === null);
      if (missing.length) return rpcResult(m.id, { content: [{ type: "text", text: `Missing argument(s): ${missing.join(", ")}` }], isError: true });
      try {
        const r = await tool.run(args, api);
        return rpcResult(m.id, {
          content: [{ type: "text", text: r.text }],
          ...(r.data !== undefined && typeof r.data === "object" && !Array.isArray(r.data) ? { structuredContent: r.data } : {}),
          ...(r.isError ? { isError: true } : {}),
        });
      } catch (e) {
        return rpcResult(m.id, { content: [{ type: "text", text: `Tool failed: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      if (m.method.startsWith("notifications/")) return null;
      return rpcError(m.id, -32601, `Method not found: ${m.method}`);
  }
}

export const MCP_TOOL_NAMES = TOOLS.map(t => t.name);
