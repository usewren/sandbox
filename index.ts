import postgres from "postgres";
import { parse as parseYaml } from "yaml";
import { auth } from "auth";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://wren:wren@localhost:5432/wren");

const openapiPath = process.env.OPENAPI_PATH ?? "../docs/openapi.yaml";
const openapiYaml = await Bun.file(openapiPath).text();
const openapiJson = parseYaml(openapiYaml);

const server = Bun.serve({
  port: 4000,

  async fetch(req) {
    const url = new URL(req.url);
    const segments = url.pathname.replace(/^\//, "").split("/");
    const [collection, id, sub, version] = segments;

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
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

    // Route: GET /{collection}
    if (req.method === "GET" && !id) {
      return handleList(collection, url);
    }

    // Route: POST /{collection}
    if (req.method === "POST" && !id) {
      return handleCreate(collection, req);
    }

    // Route: GET /{collection}/{id}
    if (req.method === "GET" && id && !sub) {
      return handleGet(collection, id);
    }

    // Route: PUT /{collection}/{id}
    if (req.method === "PUT" && id && !sub) {
      return handleUpdate(collection, id, req);
    }

    // Route: DELETE /{collection}/{id}
    if (req.method === "DELETE" && id && !sub) {
      return handleDelete(collection, id);
    }

    // Route: GET /{collection}/{id}/versions
    if (req.method === "GET" && id && sub === "versions" && !version) {
      return handleVersionList(collection, id);
    }

    // Route: GET /{collection}/{id}/versions/{v}
    if (req.method === "GET" && id && sub === "versions" && version) {
      return handleVersionGet(collection, id, version);
    }

    // Route: POST /{collection}/{id}/rollback/{v}
    if (req.method === "POST" && id && sub === "rollback" && version) {
      return handleRollback(collection, id, version);
    }

    // Route: POST /{collection}/{id}/labels
    if (req.method === "POST" && id && sub === "labels") {
      return handleLabel(collection, id, req);
    }

    // Route: GET /{collection}/{id}/diff
    if (req.method === "GET" && id && sub === "diff") {
      return handleDiff(collection, id, url);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

// --- Handlers (stubs) ---

async function handleList(collection: string, url: URL): Promise<Response> {
  return Response.json({ collection, items: [], total: 0 });
}

async function handleCreate(collection: string, req: Request): Promise<Response> {
  const body = await req.json();
  return Response.json({ collection, id: crypto.randomUUID(), data: body }, { status: 201 });
}

async function handleGet(collection: string, id: string): Promise<Response> {
  return Response.json({ collection, id, data: null });
}

async function handleUpdate(collection: string, id: string, req: Request): Promise<Response> {
  const body = await req.json();
  return Response.json({ collection, id, data: body });
}

async function handleDelete(collection: string, id: string): Promise<Response> {
  return Response.json({ collection, id, deleted: true });
}

async function handleVersionList(collection: string, id: string): Promise<Response> {
  return Response.json({ collection, id, versions: [] });
}

async function handleVersionGet(collection: string, id: string, version: string): Promise<Response> {
  return Response.json({ collection, id, version, data: null });
}

async function handleRollback(collection: string, id: string, version: string): Promise<Response> {
  return Response.json({ collection, id, rolledBackTo: version });
}

async function handleLabel(collection: string, id: string, req: Request): Promise<Response> {
  const body = await req.json();
  return Response.json({ collection, id, label: body.label });
}

async function handleDiff(collection: string, id: string, url: URL): Promise<Response> {
  const v1 = url.searchParams.get("v1");
  const v2 = url.searchParams.get("v2");
  return Response.json({ collection, id, v1, v2, diff: [] });
}

console.log(`Wren listening on http://localhost:${server.port}`);
console.log(`API docs available at http://localhost:${server.port}/docs`);
