import postgres, { type Sql } from "postgres";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "fs";
import { join, extname } from "path";
import { auth } from "auth";
import { setupCommon, createTenant, listTenants, migrateAllTenants, sanitizeSchemaName } from "db/runner";
import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true });

// Admin UI static files — built by `bun build` into public/admin/
const ADMIN_DIR = join(import.meta.dir, "public", "admin");
const ADMIN_INDEX = join(ADMIN_DIR, "index.html");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".woff2": "font/woff2",
};

function serveAdminFile(filePath: string): Response | null {
  if (!existsSync(filePath)) return null;
  const type = MIME[extname(filePath)] ?? "application/octet-stream";
  return new Response(Bun.file(filePath), { headers: { "Content-Type": type } });
}

function serveAdminIndex(): Response {
  return new Response(Bun.file(ADMIN_INDEX), { headers: { "Content-Type": "text/html" } });
}

const sql = postgres(process.env.DATABASE_URL ?? "postgres://wren:wren@localhost:5432/wren");

// Set up common schema and warm the known-tenant cache at startup
await setupCommon(sql);
await migrateAllTenants(sql);
const knownTenants = new Set((await listTenants(sql)).map(t => t.org_id));

const openapiPath = process.env.OPENAPI_PATH ?? "../docs/openapi.yaml";
const openapiYaml = await Bun.file(openapiPath).text();
const openapiJson = parseYaml(openapiYaml);

// -------------------------------------------------------
// Tenant helpers
// -------------------------------------------------------

async function ensureTenant(orgId: string): Promise<string> {
  if (!knownTenants.has(orgId)) {
    await createTenant(sql, orgId);
    knownTenants.add(orgId);
  }
  return sanitizeSchemaName(orgId);
}

// Returns the org_id (owner userId) this user's session is currently scoped to.
// Priority: explicit per-session preference → auto-select if exactly one membership → own org.
async function resolveUserOrgId(userId: string, sessionId: string | null): Promise<string> {
  if (sessionId) {
    const pref = await sql<{ org_id: string }[]>`
      SELECT org_id FROM common.session_orgs WHERE session_id = ${sessionId}
    `;
    if (pref.length) return pref[0].org_id;
  }
  // No explicit preference — auto-select if member of exactly one foreign org
  const memberships = await sql<{ org_id: string }[]>`
    SELECT org_id FROM common.org_members WHERE user_id = ${userId}
  `;
  if (memberships.length === 1) return memberships[0].org_id;
  // Multiple memberships with no preference set, or no memberships at all: use own org
  return userId;
}

async function resolveUserOrg(userId: string, sessionId: string | null): Promise<string> {
  const orgId = await resolveUserOrgId(userId, sessionId);
  return ensureTenant(orgId);
}

async function withTenant<T>(schemaName: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL search_path TO ${schemaName}, common, public`);
    return fn(tx as unknown as Sql);
  });
}

// -------------------------------------------------------
// CORS
// -------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  "http://localhost:4000",
  "http://localhost:4001",
  "http://localhost:4002",
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Cookie",
  };
}

// -------------------------------------------------------
// Auth helpers
// -------------------------------------------------------

// -------------------------------------------------------
// API key helpers
// -------------------------------------------------------

async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "wren_" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateInviteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "inv_" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

type SessionUser = { userId: string; name: string; email: string; sessionId: string | null };

async function checkApiKey(req: Request): Promise<SessionUser | null> {
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer wren_")) return null;
  const token = header.slice(7);
  const hash = await sha256hex(token);
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id FROM common.api_keys
    WHERE key_hash = ${hash} AND revoked_at IS NULL
  `;
  if (!rows.length) return null;
  const userId = rows[0].user_id;
  // Update last_used_at without blocking the request
  sql`UPDATE common.api_keys SET last_used_at = NOW() WHERE key_hash = ${hash}`.catch(() => {});
  // Fetch user info from Better Auth's user table
  const users = await sql<{ id: string; name: string; email: string }[]>`
    SELECT id, name, email FROM "user" WHERE id = ${userId}
  `;
  if (!users.length) return null;
  // API keys have no session — org switching is browser-session only
  return { userId: users[0].id, name: users[0].name, email: users[0].email, sessionId: null };
}

async function requireSession(req: Request): Promise<SessionUser | null> {
  const apiKey = await checkApiKey(req);
  if (apiKey) return apiKey;
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return null;
  return { userId: session.user.id, name: session.user.name, email: session.user.email, sessionId: session.session.id };
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

// -------------------------------------------------------
// Server
// -------------------------------------------------------

const server = Bun.serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 4000,

  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    const cors = corsHeaders(origin);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const res = await handleRequest(req, url);
    Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  },
});

async function handleRequest(req: Request, url: URL): Promise<Response> {
    const segments = url.pathname.replace(/^\//, "").split("/");
    const [collection, id, sub, version] = segments;

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // Wren logo — served from public directory (no auth required)
    if (url.pathname === "/wren-logo.svg") {
      return new Response(Bun.file(join(import.meta.dir, "public", "wren-logo.svg")), {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" },
      });
    }

    // Marketing site — served at root
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "index.html")), {
        headers: { "Content-Type": "text/html" },
      });
    }
    if (url.pathname === "/styles.css") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "styles.css")), {
        headers: { "Content-Type": "text/css" },
      });
    }
    if (url.pathname === "/tutorial" || url.pathname === "/tutorial.html") {
      return new Response(Bun.file(join(import.meta.dir, "public", "marketing", "tutorial.html")), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Admin UI — serve built static files, SPA fallback to index.html
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      const subPath = url.pathname.slice("/admin".length);
      const filePath = (!subPath || subPath === "/")
        ? ADMIN_INDEX
        : join(ADMIN_DIR, subPath);
      return serveAdminFile(filePath) ?? serveAdminIndex();
    }

    // Auth routes — handled by Better Auth
    if (url.pathname.startsWith("/api/auth")) {
      return auth.handler(req);
    }

    // Login UI
    if (url.pathname === "/login") {
      return new Response(Bun.file("public/auth.html"));
    }

    // Profile — protected route
    if (url.pathname === "/profile") {
      const isApiRequest = req.headers.get("accept")?.includes("application/json");
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session) {
        if (isApiRequest) return Response.json({ error: "Unauthorized" }, { status: 401 });
        return Response.redirect(`/login?redirect=/profile`, 302);
      }
      if (isApiRequest) return Response.json({ user: session.user });
      return new Response(Bun.file("public/profile.html"));
    }

    // OpenAPI spec
    if (url.pathname === "/openapi.json") {
      return Response.json(openapiJson);
    }

    // Scalar API docs
    if (url.pathname === "/docs") {
      return new Response(
        `<!doctype html>
<html>
  <head>
    <title>Wren API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    if (!collection) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // All data routes require authentication
    const user = await requireSession(req);
    if (!user) return unauthorized();

    // API key management routes — /api/keys[/:keyId]
    if (collection === "api" && id === "keys") {
      if (req.method === "GET"    && !sub)  return handleListApiKeys(user.userId);
      if (req.method === "POST"   && !sub)  return handleCreateApiKey(req, user.userId);
      if (req.method === "DELETE" && sub)   return handleRevokeApiKey(sub, user.userId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Org context routes — /api/org
    if (collection === "api" && id === "org" && !sub) {
      if (req.method === "GET") return handleGetOrg(user.userId, user.sessionId);
      if (req.method === "PUT") return handleSwitchOrg(req, user.userId, user.sessionId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Invite management routes — /api/invites[/:inviteId | /accept]
    if (collection === "api" && id === "invites") {
      if (req.method === "GET"    && !sub)              return handleListInvites(user.userId);
      if (req.method === "POST"   && !sub)              return handleCreateInvite(req, user.userId);
      if (req.method === "POST"   && sub === "accept")  return handleAcceptInvite(req, user.userId);
      if (req.method === "DELETE" && sub)               return handleRevokeInvite(sub, user.userId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Member management routes — /api/members[/:memberId]
    if (collection === "api" && id === "members") {
      if (req.method === "GET"    && !sub) return handleListMembers(user.userId);
      if (req.method === "DELETE" && sub)  return handleRemoveMember(sub, user.userId);
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const schemaName = await resolveUserOrg(user.userId, user.sessionId);

    // Route: GET /collections — list distinct collection names
    if (req.method === "GET" && collection === "collections" && !id) {
      return handleListCollections(schemaName);
    }

    // Tree routes: GET|PUT|DELETE /tree/{treeName}/{...path}
    // Also: GET /tree — list all tree names
    if (collection === "tree") {
      if (req.method === "GET" && !id) return handleListTrees(schemaName);
      const treeName = id; // second segment is the tree name
      const treePath = "/" + segments.slice(2).join("/");
      if (!treeName) return Response.json({ error: "Tree name required" }, { status: 400 });
      if (req.method === "GET" && url.searchParams.get("full") === "true")
        return handleTreeFull(schemaName, treeName);
      if (req.method === "GET")    return handleTreeGet(schemaName, treeName, treePath);
      if (req.method === "PUT")    return handleTreePut(schemaName, treeName, treePath, req, user.userId);
      if (req.method === "DELETE") return handleTreeDelete(schemaName, treeName, treePath, user.userId);
    }

    // Route: GET /{collection}
    if (req.method === "GET" && !id) {
      return handleList(schemaName, collection, url, user.userId);
    }

    // Schema routes: GET|PUT|DELETE /{collection}/_schema
    if (id === "_schema" && !sub) {
      if (req.method === "GET")    return handleGetSchema(schemaName, collection);
      if (req.method === "PUT")    return handleSetSchema(schemaName, collection, req, user.userId);
      if (req.method === "DELETE") return handleDeleteSchema(schemaName, collection);
    }

    // Route: GET /{collection}/{id}/raw  (binary asset download)
    if (req.method === "GET" && id && sub === "raw") {
      return handleGetAssetRaw(schemaName, collection, id, url);
    }

    // Route: GET /{collection}/{id}
    if (req.method === "GET" && id && !sub) {
      return handleGet(schemaName, collection, id, url);
    }

    // Route: POST /{collection}  — multipart = binary upload, JSON = document
    if (req.method === "POST" && !id) {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.startsWith("multipart/form-data")) {
        return handleCreateAsset(schemaName, collection, req, user.userId);
      }
      return handleCreate(schemaName, collection, req, user.userId);
    }

    // Route: PUT /{collection}/{id}  — multipart = new binary version, JSON = document update
    if (req.method === "PUT" && id && !sub) {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.startsWith("multipart/form-data")) {
        return handleUpdateAsset(schemaName, collection, id, req, user.userId);
      }
      return handleUpdate(schemaName, collection, id, req, user.userId);
    }

    // Route: DELETE /{collection}/{id}
    if (req.method === "DELETE" && id && !sub) {
      return handleDelete(schemaName, collection, id);
    }

    // Route: GET /{collection}/{id}/paths
    if (req.method === "GET" && id && sub === "paths" && !version) {
      return handleDocumentPaths(schemaName, collection, id);
    }

    // Route: GET /{collection}/{id}/versions
    if (req.method === "GET" && id && sub === "versions" && !version) {
      return handleVersionList(schemaName, collection, id);
    }

    // Route: GET /{collection}/{id}/versions/{v}
    if (req.method === "GET" && id && sub === "versions" && version) {
      return handleVersionGet(schemaName, collection, id, version);
    }

    // Route: POST /{collection}/{id}/rollback/{v}
    if (req.method === "POST" && id && sub === "rollback" && version) {
      return handleRollback(schemaName, collection, id, version, user.userId);
    }

    // Route: POST /{collection}/{id}/labels
    if (req.method === "POST" && id && sub === "labels") {
      return handleLabel(schemaName, collection, id, req, user.userId);
    }

    // Route: GET /{collection}/{id}/diff
    if (req.method === "GET" && id && sub === "diff") {
      return handleDiff(schemaName, collection, id, url);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
}

// -------------------------------------------------------
// Handlers
// -------------------------------------------------------

async function handleList(schemaName: string, collection: string, url: URL, _userId: string): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0");

  const [items, [{ total }]] = await withTenant(schemaName, async tx => {
    const rows = await tx<{ id: string; version: number; data: unknown; created_at: Date; updated_at: Date }[]>`
      SELECT d.id, d.current_version AS version, v.data, d.created_at, d.updated_at
      FROM documents d
      JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE d.collection = ${collection} AND d.deleted_at IS NULL
      ORDER BY d.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const count = await tx<{ total: string }[]>`
      SELECT COUNT(*)::text AS total FROM documents
      WHERE collection = ${collection} AND deleted_at IS NULL
    `;
    return [rows, count];
  });

  return Response.json({
    collection,
    items: items.map(r => ({ id: r.id, version: r.version, data: r.data, createdAt: r.created_at, updatedAt: r.updated_at })),
    total: parseInt(total),
  });
}

async function getCollectionType(schemaName: string, collection: string): Promise<"json" | "binary"> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ collection_type: string }[]>`
      SELECT collection_type FROM collection_schemas WHERE collection = ${collection}
    `
  );
  return (rows[0]?.collection_type === "binary") ? "binary" : "json";
}

async function validateAgainstSchema(schemaName: string, collection: string, data: unknown): Promise<string[] | null> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ schema: unknown; collection_type: string }[]>`
      SELECT schema, collection_type FROM collection_schemas WHERE collection = ${collection}
    `
  );
  if (rows.length === 0) return null;
  if (rows[0].collection_type === "binary") return null; // binary collections skip JSON validation
  const validate = ajv.compile(rows[0].schema as object);
  if (validate(data)) return null;
  return (validate.errors ?? []).map(e => `${e.instancePath || "/"} ${e.message}`);
}

// ── Binary asset helpers ─────────────────────────────────────────────────────

async function insertAssetVersion(
  schemaName: string,
  docId: string,
  version: number,
  file: File,
  userId: string,
): Promise<void> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const meta = {
    _binary:  true,
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    size:     buffer.byteLength,
  };
  await withTenant(schemaName, async tx => {
    await tx`
      INSERT INTO versions (document_id, version, data, created_by)
      VALUES (${docId}, ${version}, ${tx.json(meta)}, ${userId})
    `;
    await tx`
      INSERT INTO asset_contents (document_id, version, data, mime_type, filename, size)
      VALUES (${docId}, ${version}, ${buffer}, ${meta.mimeType}, ${meta.filename}, ${meta.size})
    `;
  });
}

async function handleCreateAsset(schemaName: string, collection: string, req: Request, userId: string): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Missing file field" }, { status: 400 });

  const docId = await withTenant(schemaName, async tx => {
    const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO documents (collection, current_version, created_by)
      VALUES (${collection}, 1, ${userId})
      RETURNING id
    `;
    return inserted.id;
  });

  await insertAssetVersion(schemaName, docId, 1, file, userId);

  const doc = await withTenant(schemaName, async tx => {
    const [row] = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
      SELECT id, created_at, updated_at FROM documents WHERE id = ${docId}
    `;
    return row;
  });

  return Response.json({
    id: doc.id, version: 1, collection,
    data: { _binary: true, filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size },
    createdAt: doc.created_at, updatedAt: doc.updated_at,
  }, { status: 201 });
}

async function handleUpdateAsset(schemaName: string, collection: string, docId: string, req: Request, userId: string): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Missing file field" }, { status: 400 });

  const existing = await withTenant(schemaName, async tx => {
    const [row] = await tx<{ current_version: number }[]>`
      SELECT current_version FROM documents WHERE id = ${docId} AND collection = ${collection} AND deleted_at IS NULL
    `;
    return row;
  });
  if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

  const newVersion = existing.current_version + 1;
  await insertAssetVersion(schemaName, docId, newVersion, file, userId);

  const doc = await withTenant(schemaName, async tx => {
    const [row] = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
      UPDATE documents SET current_version = ${newVersion}, updated_at = NOW()
      WHERE id = ${docId}
      RETURNING id, created_at, updated_at
    `;
    return row;
  });

  return Response.json({
    id: doc.id, version: newVersion, collection,
    data: { _binary: true, filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size },
    createdAt: doc.created_at, updatedAt: doc.updated_at,
  });
}

async function handleGetAssetRaw(schemaName: string, collection: string, docId: string, url: URL): Promise<Response> {
  const versionParam = url.searchParams.get("version");
  const rows = await withTenant(schemaName, async tx => {
    if (versionParam) {
      return tx<{ data: Buffer; mime_type: string; filename: string }[]>`
        SELECT ac.data, ac.mime_type, ac.filename
        FROM asset_contents ac
        WHERE ac.document_id = ${docId} AND ac.version = ${parseInt(versionParam)}
      `;
    }
    return tx<{ data: Buffer; mime_type: string; filename: string }[]>`
      SELECT ac.data, ac.mime_type, ac.filename
      FROM asset_contents ac
      JOIN documents d ON d.id = ac.document_id AND d.current_version = ac.version
      WHERE ac.document_id = ${docId} AND d.collection = ${collection} AND d.deleted_at IS NULL
    `;
  });
  if (rows.length === 0) return Response.json({ error: "Not found" }, { status: 404 });
  const { data, mime_type, filename } = rows[0];
  return new Response(data, {
    headers: {
      "Content-Type": mime_type,
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

async function handleCreate(schemaName: string, collection: string, req: Request, userId: string): Promise<Response> {
  const data = await req.json();

  const errors = await validateAgainstSchema(schemaName, collection, data);
  if (errors) return Response.json({ error: "Schema validation failed", details: errors }, { status: 422 });

  const doc = await withTenant(schemaName, async tx => {
    const [inserted] = await tx<{ id: string; created_at: Date; updated_at: Date }[]>`
      INSERT INTO documents (collection, current_version, created_by)
      VALUES (${collection}, 1, ${userId})
      RETURNING id, created_at, updated_at
    `;
    await tx`
      INSERT INTO versions (document_id, version, data, created_by)
      VALUES (${inserted.id}, 1, ${tx.json(data)}, ${userId})
    `;
    return inserted;
  });

  return Response.json(
    { id: doc.id, version: 1, collection, data, createdAt: doc.created_at, updatedAt: doc.updated_at },
    { status: 201 }
  );
}

async function handleGet(schemaName: string, collection: string, id: string, url: URL): Promise<Response> {
  const label = url.searchParams.get("label");

  const row = await withTenant(schemaName, async tx => {
    if (label) {
      const rows = await tx<{ id: string; version: number; data: unknown; created_at: Date; updated_at: Date }[]>`
        SELECT d.id, l.version, v.data, d.created_at, d.updated_at
        FROM documents d
        JOIN labels l ON l.document_id = d.id AND l.label = ${label}
        JOIN versions v ON v.document_id = d.id AND v.version = l.version
        WHERE d.id = ${id} AND d.collection = ${collection} AND d.deleted_at IS NULL
      `;
      return rows[0] ?? null;
    }
    const rows = await tx<{ id: string; version: number; data: unknown; created_at: Date; updated_at: Date }[]>`
      SELECT d.id, d.current_version AS version, v.data, d.created_at, d.updated_at
      FROM documents d
      JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE d.id = ${id} AND d.collection = ${collection} AND d.deleted_at IS NULL
    `;
    return rows[0] ?? null;
  });

  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: row.id, version: row.version, collection, data: row.data, createdAt: row.created_at, updatedAt: row.updated_at });
}

async function handleUpdate(schemaName: string, collection: string, id: string, req: Request, userId: string): Promise<Response> {
  const data = await req.json();

  const errors = await validateAgainstSchema(schemaName, collection, data);
  if (errors) return Response.json({ error: "Schema validation failed", details: errors }, { status: 422 });

  const result = await withTenant(schemaName, async tx => {
    const [doc] = await tx<{ id: string; current_version: number }[]>`
      SELECT id, current_version FROM documents
      WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (!doc) return null;

    const newVersion = doc.current_version + 1;
    await tx`
      INSERT INTO versions (document_id, version, data, created_by)
      VALUES (${id}, ${newVersion}, ${tx.json(data)}, ${userId})
    `;
    const [updated] = await tx<{ updated_at: Date }[]>`
      UPDATE documents SET current_version = ${newVersion}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING updated_at
    `;
    return { version: newVersion, updated_at: updated.updated_at };
  });

  if (!result) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, version: result.version, collection, data, updatedAt: result.updated_at });
}

async function handleDelete(schemaName: string, collection: string, id: string): Promise<Response> {
  const affected = await withTenant(schemaName, async tx => {
    const rows = await tx<{ id: string }[]>`
      UPDATE documents SET deleted_at = NOW()
      WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
      RETURNING id
    `;
    return rows.length;
  });

  if (!affected) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, deleted: true });
}

async function handleVersionList(schemaName: string, collection: string, id: string): Promise<Response> {
  const versions = await withTenant(schemaName, async tx => {
    // Verify doc exists
    const [doc] = await tx<{ id: string }[]>`
      SELECT id FROM documents WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
    `;
    if (!doc) return null;

    const rows = await tx<{ version: number; created_at: Date; created_by: string }[]>`
      SELECT version, created_at, created_by
      FROM versions WHERE document_id = ${id}
      ORDER BY version ASC
    `;
    return rows.map(r => ({ version: r.version, createdAt: r.created_at, createdBy: r.created_by }));
  });

  if (!versions) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, collection, versions });
}

async function handleVersionGet(schemaName: string, collection: string, id: string, versionStr: string): Promise<Response> {
  const version = parseInt(versionStr, 10);
  if (isNaN(version)) return Response.json({ error: "Invalid version" }, { status: 400 });

  const row = await withTenant(schemaName, async tx => {
    const rows = await tx<{ data: unknown; created_at: Date }[]>`
      SELECT v.data, v.created_at
      FROM versions v
      JOIN documents d ON d.id = v.document_id
      WHERE v.document_id = ${id} AND v.version = ${version}
        AND d.collection = ${collection}
    `;
    return rows[0] ?? null;
  });

  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, collection, version, data: row.data, createdAt: row.created_at });
}

async function handleRollback(schemaName: string, collection: string, id: string, versionStr: string, userId: string): Promise<Response> {
  const targetVersion = parseInt(versionStr, 10);
  if (isNaN(targetVersion)) return Response.json({ error: "Invalid version" }, { status: 400 });

  const result = await withTenant(schemaName, async tx => {
    const [doc] = await tx<{ current_version: number }[]>`
      SELECT current_version FROM documents
      WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (!doc) return null;

    const [targetRow] = await tx<{ data: unknown }[]>`
      SELECT data FROM versions WHERE document_id = ${id} AND version = ${targetVersion}
    `;
    if (!targetRow) return null;

    const newVersion = doc.current_version + 1;
    await tx`
      INSERT INTO versions (document_id, version, data, created_by)
      VALUES (${id}, ${newVersion}, ${tx.json(targetRow.data)}, ${userId})
    `;
    await tx`
      UPDATE documents SET current_version = ${newVersion}, updated_at = NOW() WHERE id = ${id}
    `;
    return { newVersion, rolledBackTo: targetVersion };
  });

  if (!result) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, version: result.newVersion, rolledBackTo: result.rolledBackTo });
}

async function handleLabel(schemaName: string, collection: string, id: string, req: Request, userId: string): Promise<Response> {
  const body = await req.json() as { label: string; version?: number };
  const { label } = body;
  if (!label) return Response.json({ error: "label is required" }, { status: 400 });

  const result = await withTenant(schemaName, async tx => {
    const [doc] = await tx<{ current_version: number }[]>`
      SELECT current_version FROM documents
      WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
    `;
    if (!doc) return null;

    // Use explicitly requested version if provided, otherwise current
    const targetVersion = (typeof body.version === "number") ? body.version : doc.current_version;

    // Verify the target version exists
    const [vrow] = await tx<{ version: number }[]>`
      SELECT version FROM versions WHERE document_id = ${id} AND version = ${targetVersion}
    `;
    if (!vrow) return "version_not_found" as const;

    await tx`
      INSERT INTO labels (document_id, label, version, created_by)
      VALUES (${id}, ${label}, ${targetVersion}, ${userId})
      ON CONFLICT (document_id, label) DO UPDATE
        SET version = EXCLUDED.version, updated_at = NOW()
    `;
    return { label, version: targetVersion };
  });

  if (!result) return Response.json({ error: "Not found" }, { status: 404 });
  if (result === "version_not_found") return Response.json({ error: "Version not found" }, { status: 404 });
  return Response.json({ id, label: result.label, version: result.version });
}

async function handleDocumentPaths(schemaName: string, collection: string, id: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx => {
    const [doc] = await tx<{ id: string }[]>`
      SELECT id FROM documents WHERE id = ${id} AND collection = ${collection} AND deleted_at IS NULL
    `;
    if (!doc) return null;
    return tx<{ tree: string; path: string }[]>`
      SELECT tree, path FROM paths WHERE document_id = ${id} ORDER BY tree, path
    `;
  });
  if (!rows) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, collection, paths: rows });
}

async function handleGetSchema(schemaName: string, collection: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ schema: unknown; display_name: string | null; collection_type: string; updated_at: Date }[]>`
      SELECT schema, display_name, collection_type, updated_at FROM collection_schemas WHERE collection = ${collection}
    `
  );
  if (rows.length === 0) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    collection,
    collectionType: rows[0].collection_type,
    schema:         rows[0].collection_type === "binary" ? null : rows[0].schema,
    displayName:    rows[0].display_name ?? null,
    updatedAt:      rows[0].updated_at,
  });
}

async function handleSetSchema(schemaName: string, collection: string, req: Request, userId: string): Promise<Response> {
  const body = await req.json() as Record<string, unknown>;

  // Accept either a plain JSON Schema or a wrapper { schema?, displayName?, collectionType? }
  const isWrapper = body && typeof body === "object" && ("schema" in body || "collectionType" in body || "displayName" in body);
  const collectionType: string =
    (isWrapper && typeof body.collectionType === "string") ? body.collectionType : "json";
  const schema = collectionType === "binary"
    ? {}   // binary collections don't need a JSON Schema
    : (isWrapper ? body.schema : body) ?? {};
  const displayName: string | null =
    (isWrapper && typeof body.displayName === "string") ? body.displayName : null;

  if (collectionType !== "binary") {
    try { ajv.compile(schema as object); }
    catch (e) { return Response.json({ error: "Invalid JSON Schema", details: String(e) }, { status: 422 }); }
  }

  await withTenant(schemaName, async tx => {
    await tx`
      INSERT INTO collection_schemas (collection, schema, display_name, collection_type, created_by)
      VALUES (${collection}, ${tx.json(schema)}, ${displayName}, ${collectionType}, ${userId})
      ON CONFLICT (collection) DO UPDATE
        SET schema          = EXCLUDED.schema,
            display_name    = EXCLUDED.display_name,
            collection_type = EXCLUDED.collection_type,
            updated_at      = NOW()
    `;
  });
  return Response.json({ collection, collectionType, schema: collectionType === "binary" ? null : schema, displayName });
}

async function handleDeleteSchema(schemaName: string, collection: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ collection: string }[]>`
      DELETE FROM collection_schemas WHERE collection = ${collection} RETURNING collection
    `
  );
  if (rows.length === 0) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ collection, deleted: true });
}

async function handleListCollections(schemaName: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ collection: string; count: string; updated_at: Date | null }[]>`
      SELECT
        COALESCE(d.collection, s.collection) AS collection,
        COALESCE(d.count, '0')               AS count,
        d.updated_at
      FROM (
        SELECT collection, COUNT(*)::text AS count, MAX(updated_at) AS updated_at
        FROM documents WHERE deleted_at IS NULL
        GROUP BY collection
      ) d
      FULL OUTER JOIN collection_schemas s ON d.collection = s.collection
      ORDER BY collection
    `
  );
  return Response.json({ collections: rows.map(r => ({ name: r.collection, count: parseInt(r.count), updatedAt: r.updated_at })) });
}

async function handleDiff(schemaName: string, collection: string, id: string, url: URL): Promise<Response> {
  const v1 = parseInt(url.searchParams.get("v1") ?? "", 10);
  const v2 = parseInt(url.searchParams.get("v2") ?? "", 10);
  if (isNaN(v1) || isNaN(v2)) return Response.json({ error: "v1 and v2 are required" }, { status: 400 });

  const result = await withTenant(schemaName, async tx => {
    const rows = await tx<{ version: number; data: Record<string, unknown> }[]>`
      SELECT v.version, v.data
      FROM versions v
      JOIN documents d ON d.id = v.document_id
      WHERE v.document_id = ${id} AND v.version IN (${v1}, ${v2})
        AND d.collection = ${collection}
      ORDER BY v.version
    `;
    if (rows.length < 2) return null;
    const byVersion = Object.fromEntries(rows.map(r => [r.version, r.data]));
    return { before: byVersion[v1], after: byVersion[v2] };
  });

  if (!result) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id, collection, v1, v2, diff: computeDiff(result.before, result.after) });
}

// -------------------------------------------------------
// Tree handlers
// -------------------------------------------------------

async function handleListTrees(schemaName: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx =>
    tx<{ tree: string; count: string }[]>`
      SELECT tree, COUNT(*)::text AS count FROM paths GROUP BY tree ORDER BY tree
    `
  );
  return Response.json({ trees: rows.map(r => ({ name: r.tree, count: parseInt(r.count) })) });
}

async function handleTreeFull(schemaName: string, treeName: string): Promise<Response> {
  const nodes = await withTenant(schemaName, async tx =>
    tx<{ path: string; document_id: string; collection: string; version: number; data: unknown }[]>`
      SELECT p.path, p.document_id, d.collection, d.current_version AS version, v.data
      FROM paths p
      JOIN documents d ON d.id = p.document_id AND d.deleted_at IS NULL
      JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
      WHERE p.tree = ${treeName}
      ORDER BY p.path
    `
  );
  return Response.json({
    tree: treeName,
    nodes: nodes.map(n => ({
      path: n.path,
      documentId: n.document_id,
      document: { id: n.document_id, collection: n.collection, version: n.version, data: n.data },
    })),
  });
}

async function handleTreeGet(schemaName: string, treeName: string, treePath: string): Promise<Response> {
  const result = await withTenant(schemaName, async tx => {
    // Exact match at this path in this tree
    const [exact] = await tx<{ document_id: string; assignment_doc_id: string | null }[]>`
      SELECT document_id, assignment_doc_id FROM paths WHERE tree = ${treeName} AND path = ${treePath}
    `;

    // Direct children — paths one level deeper
    const prefix = treePath.replace(/\/$/, "") + "/";
    const children = await tx<{ document_id: string; path: string }[]>`
      SELECT document_id, path FROM paths
      WHERE tree = ${treeName} AND path LIKE ${prefix + "%"}
      ORDER BY path
    `;

    let doc = null;
    if (exact) {
      const [row] = await tx<{ id: string; collection: string; version: number; data: unknown }[]>`
        SELECT d.id, d.collection, d.current_version AS version, v.data
        FROM documents d
        JOIN versions v ON v.document_id = d.id AND v.version = d.current_version
        WHERE d.id = ${exact.document_id} AND d.deleted_at IS NULL
      `;
      doc = row ?? null;
    }

    return { tree: treeName, path: treePath, document: doc, assignmentDocId: exact?.assignment_doc_id ?? null, children: children.map(c => ({ path: c.path, documentId: c.document_id })) };
  });

  if (!result.document && result.children.length === 0) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json(result);
}

async function handleTreePut(schemaName: string, treeName: string, treePath: string, req: Request, userId: string): Promise<Response> {
  const { documentId } = await req.json() as { documentId: string };
  if (!documentId) return Response.json({ error: "documentId is required" }, { status: 400 });

  await withTenant(schemaName, async tx => {
    const [doc] = await tx<{ id: string }[]>`
      SELECT id FROM documents WHERE id = ${documentId} AND deleted_at IS NULL
    `;
    if (!doc) throw new Error("Document not found");

    // Get existing path row (if any) to find the assignment doc
    const [existing] = await tx<{ assignment_doc_id: string | null }[]>`
      SELECT assignment_doc_id FROM paths WHERE tree = ${treeName} AND path = ${treePath}
    `;

    const assignmentData = { tree: treeName, path: treePath, documentId };
    let assignmentDocId: string;

    if (existing?.assignment_doc_id) {
      // Update the existing assignment document — creates a new version
      assignmentDocId = existing.assignment_doc_id;
      const [assignDoc] = await tx<{ current_version: number }[]>`
        SELECT current_version FROM documents WHERE id = ${assignmentDocId}
      `;
      const newVersion = assignDoc.current_version + 1;
      await tx`
        INSERT INTO versions (document_id, version, data, created_by)
        VALUES (${assignmentDocId}, ${newVersion}, ${tx.json(assignmentData)}, ${userId})
      `;
      await tx`
        UPDATE documents SET current_version = ${newVersion}, updated_at = NOW()
        WHERE id = ${assignmentDocId}
      `;
    } else {
      // Create a new assignment document in the _paths collection
      const [newDoc] = await tx<{ id: string }[]>`
        INSERT INTO documents (collection, current_version, created_by)
        VALUES ('_paths', 1, ${userId})
        RETURNING id
      `;
      assignmentDocId = newDoc.id;
      await tx`
        INSERT INTO versions (document_id, version, data, created_by)
        VALUES (${assignmentDocId}, 1, ${tx.json(assignmentData)}, ${userId})
      `;
    }

    // Upsert the path row with the assignment doc reference
    await tx`
      INSERT INTO paths (document_id, tree, path, assignment_doc_id)
      VALUES (${documentId}, ${treeName}, ${treePath}, ${assignmentDocId})
      ON CONFLICT (tree, path) DO UPDATE
        SET document_id = EXCLUDED.document_id,
            assignment_doc_id = EXCLUDED.assignment_doc_id
    `;
  });

  return Response.json({ tree: treeName, path: treePath, documentId });
}

async function handleTreeDelete(schemaName: string, treeName: string, treePath: string, userId: string): Promise<Response> {
  const rows = await withTenant(schemaName, async tx => {
    const [existing] = await tx<{ path: string; assignment_doc_id: string | null }[]>`
      DELETE FROM paths WHERE tree = ${treeName} AND path = ${treePath}
      RETURNING path, assignment_doc_id
    `;
    if (!existing) return null;

    // Record a tombstone version on the assignment document
    if (existing.assignment_doc_id) {
      const [assignDoc] = await tx<{ current_version: number }[]>`
        SELECT current_version FROM documents WHERE id = ${existing.assignment_doc_id}
      `;
      const newVersion = assignDoc.current_version + 1;
      await tx`
        INSERT INTO versions (document_id, version, data, created_by)
        VALUES (${existing.assignment_doc_id}, ${newVersion},
                ${tx.json({ tree: treeName, path: treePath, documentId: null, removed: true })},
                ${userId})
      `;
      await tx`
        UPDATE documents SET current_version = ${newVersion}, updated_at = NOW()
        WHERE id = ${existing.assignment_doc_id}
      `;
    }

    return existing;
  });

  if (!rows) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ tree: treeName, path: treePath, removed: true });
}

// -------------------------------------------------------
// API key handlers
// -------------------------------------------------------

async function handleListApiKeys(userId: string): Promise<Response> {
  const keys = await sql<{
    id: string; name: string; key_prefix: string;
    created_at: Date; last_used_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
    FROM common.api_keys
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;
  return Response.json({
    keys: keys.map(k => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.key_prefix,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revokedAt: k.revoked_at,
    })),
  });
}

async function handleCreateApiKey(req: Request, userId: string): Promise<Response> {
  const body = await req.json() as { name?: string };
  const name = body.name?.trim();
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const rawKey = generateApiKey();
  const keyHash = await sha256hex(rawKey);
  const keyPrefix = rawKey.slice(0, 12); // "wren_" + 7 hex chars

  const [key] = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO common.api_keys (user_id, name, key_hash, key_prefix)
    VALUES (${userId}, ${name}, ${keyHash}, ${keyPrefix})
    RETURNING id, created_at
  `;
  return Response.json({
    id: key.id,
    name,
    keyPrefix,
    key: rawKey, // returned once only — never stored in plaintext
    createdAt: key.created_at,
    lastUsedAt: null,
    revokedAt: null,
  }, { status: 201 });
}

async function handleRevokeApiKey(keyId: string, userId: string): Promise<Response> {
  const rows = await sql<{ id: string }[]>`
    UPDATE common.api_keys
    SET revoked_at = NOW()
    WHERE id = ${keyId} AND user_id = ${userId} AND revoked_at IS NULL
    RETURNING id
  `;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: keyId, revoked: true });
}

// -------------------------------------------------------
// Org context handlers
// -------------------------------------------------------

async function handleGetOrg(userId: string, sessionId: string | null): Promise<Response> {
  const current = await resolveUserOrgId(userId, sessionId);

  // All orgs accessible to this user: own + any they're a member of
  const memberships = await sql<{ org_id: string }[]>`
    SELECT org_id FROM common.org_members WHERE user_id = ${userId}
  `;
  const foreignIds = memberships.map(m => m.org_id);
  const owners = foreignIds.length
    ? await sql<{ id: string; name: string; email: string }[]>`
        SELECT id, name, email FROM "user" WHERE id = ANY(${foreignIds})
      `
    : [];

  const orgs = [
    { id: userId, name: "My workspace", own: true },
    ...owners.map(o => ({ id: o.id, name: o.name, email: o.email, own: false })),
  ];

  return Response.json({ current, orgs });
}

async function handleSwitchOrg(req: Request, userId: string, sessionId: string | null): Promise<Response> {
  if (!sessionId) {
    return Response.json({ error: "Org switching requires a browser session, not an API key" }, { status: 400 });
  }
  const body = await req.json() as { orgId?: string };
  const orgId = body.orgId?.trim();
  if (!orgId) return Response.json({ error: "orgId is required" }, { status: 400 });

  // Validate: must be own org or an org the user is a member of
  if (orgId !== userId) {
    const rows = await sql<{ org_id: string }[]>`
      SELECT org_id FROM common.org_members
      WHERE org_id = ${orgId} AND user_id = ${userId}
    `;
    if (!rows.length) return Response.json({ error: "Not a member of that org" }, { status: 403 });
  }

  await sql`
    INSERT INTO common.session_orgs (session_id, org_id)
    VALUES (${sessionId}, ${orgId})
    ON CONFLICT (session_id) DO UPDATE SET org_id = ${orgId}, updated_at = NOW()
  `;

  return Response.json({ current: orgId });
}

// -------------------------------------------------------
// Invite handlers
// -------------------------------------------------------

async function handleListInvites(userId: string): Promise<Response> {
  const invites = await sql<{
    id: string; email: string; role: string;
    created_at: Date; expires_at: Date;
    accepted_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, email, role, created_at, expires_at, accepted_at, revoked_at
    FROM common.invites
    WHERE org_id = ${userId}
    ORDER BY created_at DESC
  `;
  return Response.json({
    invites: invites.map(i => ({
      id: i.id,
      email: i.email,
      role: i.role,
      createdAt: i.created_at,
      expiresAt: i.expires_at,
      acceptedAt: i.accepted_at,
      revokedAt: i.revoked_at,
    })),
  });
}

async function handleCreateInvite(req: Request, userId: string): Promise<Response> {
  const body = await req.json() as { email?: string; role?: string };
  const email = body.email?.trim().toLowerCase();
  const role = body.role ?? "member";
  if (!email) return Response.json({ error: "email is required" }, { status: 400 });

  const rawToken = generateInviteToken();
  const tokenHash = await sha256hex(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);

  const [invite] = await sql<{ id: string; created_at: Date; expires_at: Date }[]>`
    INSERT INTO common.invites (org_id, email, token_hash, token_prefix, role, invited_by)
    VALUES (${userId}, ${email}, ${tokenHash}, ${tokenPrefix}, ${role}, ${userId})
    RETURNING id, created_at, expires_at
  `;
  return Response.json({
    id: invite.id,
    email,
    role,
    token: rawToken, // returned once only — never stored in plaintext
    createdAt: invite.created_at,
    expiresAt: invite.expires_at,
    acceptedAt: null,
    revokedAt: null,
  }, { status: 201 });
}

async function handleRevokeInvite(inviteId: string, userId: string): Promise<Response> {
  const rows = await sql<{ id: string }[]>`
    UPDATE common.invites
    SET revoked_at = NOW()
    WHERE id = ${inviteId} AND org_id = ${userId} AND revoked_at IS NULL AND accepted_at IS NULL
    RETURNING id
  `;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ id: inviteId, revoked: true });
}

async function handleAcceptInvite(req: Request, userId: string): Promise<Response> {
  const body = await req.json() as { token?: string };
  const token = body.token?.trim();
  if (!token) return Response.json({ error: "token is required" }, { status: 400 });

  const tokenHash = await sha256hex(token);
  const [invite] = await sql<{
    id: string; org_id: string; email: string; role: string;
    expires_at: Date; accepted_at: Date | null; revoked_at: Date | null;
  }[]>`
    SELECT id, org_id, email, role, expires_at, accepted_at, revoked_at
    FROM common.invites WHERE token_hash = ${tokenHash}
  `;
  if (!invite)             return Response.json({ error: "Invalid invite token" }, { status: 404 });
  if (invite.revoked_at)   return Response.json({ error: "Invite has been revoked" }, { status: 410 });
  if (invite.accepted_at)  return Response.json({ error: "Invite already accepted" }, { status: 409 });
  if (new Date(invite.expires_at) < new Date())
                           return Response.json({ error: "Invite has expired" }, { status: 410 });
  if (invite.org_id === userId)
                           return Response.json({ error: "Cannot accept your own invite" }, { status: 400 });

  await sql`
    INSERT INTO common.org_members (org_id, user_id, role)
    VALUES (${invite.org_id}, ${userId}, ${invite.role})
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = ${invite.role}
  `;
  await sql`UPDATE common.invites SET accepted_at = NOW() WHERE id = ${invite.id}`;

  return Response.json({ accepted: true, orgId: invite.org_id });
}

// -------------------------------------------------------
// Member handlers
// -------------------------------------------------------

async function handleListMembers(userId: string): Promise<Response> {
  const members = await sql<{ user_id: string; role: string; joined_at: Date; name: string; email: string }[]>`
    SELECT m.user_id, m.role, m.joined_at, u.name, u.email
    FROM common.org_members m
    JOIN "user" u ON u.id = m.user_id
    WHERE m.org_id = ${userId}
    ORDER BY m.joined_at ASC
  `;
  return Response.json({
    members: members.map(m => ({
      userId: m.user_id,
      role: m.role,
      joinedAt: m.joined_at,
      name: m.name,
      email: m.email,
    })),
  });
}

async function handleRemoveMember(memberId: string, userId: string): Promise<Response> {
  const rows = await sql<{ user_id: string }[]>`
    DELETE FROM common.org_members
    WHERE org_id = ${userId} AND user_id = ${memberId}
    RETURNING user_id
  `;
  if (!rows.length) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ userId: memberId, removed: true });
}

// -------------------------------------------------------
// Simple flat JSON diff
// -------------------------------------------------------

type DiffEntry = { op: "add" | "remove" | "replace"; path: string; value?: unknown; oldValue?: unknown };

function computeDiff(before: Record<string, unknown>, after: Record<string, unknown>): DiffEntry[] {
  const diff: DiffEntry[] = [];
  const allKeys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of allKeys) {
    const path = `/${key}`;
    const had = Object.hasOwn(before ?? {}, key);
    const has = Object.hasOwn(after ?? {}, key);
    if (!had && has) diff.push({ op: "add", path, value: after[key] });
    else if (had && !has) diff.push({ op: "remove", path, oldValue: before[key] });
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      diff.push({ op: "replace", path, value: after[key], oldValue: before[key] });
  }
  return diff;
}

export default server;

console.log(`Wren listening on http://localhost:${server.port}`);
console.log(`API docs available at http://localhost:${server.port}/docs`);
