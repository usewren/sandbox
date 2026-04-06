import { describe, it, expect, beforeAll } from "bun:test";
import { post, get, signUp, signIn } from "../setup";

const email = `collections+${Date.now()}@wren.dev`;
let cookie: string;

beforeAll(async () => {
  await signUp(email, "secret123", "Test User");
  ({ cookie } = await signIn(email, "secret123"));
});

describe("collections", () => {
  describe("GET /api/v1/{collection}", () => {
    it("returns empty list for new collection", async () => {
      const res = await get("/api/v1/pages", cookie);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toBeArray();
      expect(typeof body.total).toBe("number");
    });

    it("requires authentication", async () => {
      const res = await get("/api/v1/pages");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/v1/{collection}", () => {
    it("creates a document and returns version 1", async () => {
      const res = await post("/api/v1/pages", { title: "Hello", body: "World" }, cookie);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBeTruthy();
      expect(body.version).toBe(1);
      expect(body.data.title).toBe("Hello");
    });

    it("requires authentication", async () => {
      const res = await post("/api/v1/pages", { title: "Hello" });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/v1/{collection}/{id}", () => {
    it("returns the created document", async () => {
      const create = await post("/api/v1/pages", { title: "Fetch me" }, cookie);
      const { id } = await create.json();
      const res = await get(`/api/v1/pages/${id}`, cookie);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.title).toBe("Fetch me");
    });

    it("returns 404 for unknown id", async () => {
      const res = await get("/api/v1/pages/does-not-exist", cookie);
      expect(res.status).toBe(404);
    });
  });
});
