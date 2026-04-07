import { describe, it, expect, beforeAll } from "bun:test";
import { post, get, signUp, signIn, BASE_URL } from "../setup";

// E2E: full document lifecycle — create, update, version, label, rollback, diff

const email = `lifecycle+${Date.now()}@wren.dev`;
let cookie: string;
let docId: string;

beforeAll(async () => {
  await signUp(email, "secret123", "Lifecycle User");
  ({ cookie } = await signIn(email, "secret123"));
});

describe("document lifecycle", () => {
  it("creates a document at version 1", async () => {
    const res = await post("/api/v1/pages", { title: "v1", body: "initial" }, cookie);
    expect(res.status).toBe(201);
    const body = await res.json();
    docId = body.id;
    expect(body.version).toBe(1);
  });

  it("updates the document to version 2", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/pages/${docId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Origin": BASE_URL, Cookie: cookie },
      body: JSON.stringify({ title: "v2", body: "updated" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(2);
    expect(body.data.title).toBe("v2");
  });

  it("lists two versions in history", async () => {
    const res = await get(`/api/v1/pages/${docId}/versions`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions).toHaveLength(2);
  });

  it("labels version 2 as published", async () => {
    const res = await post(`/api/v1/pages/${docId}/labels`, { label: "published" }, cookie);
    expect(res.status).toBe(200);
  });

  it("fetches document at published label", async () => {
    const res = await get(`/api/v1/pages/${docId}?label=published`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("v2");
  });

  it("rolls back to version 1", async () => {
    const res = await post(`/api/v1/pages/${docId}/rollback/1`, {}, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rolledBackTo).toBe(1);
  });

  it("current state is now v1 content", async () => {
    const res = await get(`/api/v1/pages/${docId}`, cookie);
    const body = await res.json();
    expect(body.data.title).toBe("v1");
  });

  it("diffs v1 and v2", async () => {
    const res = await get(`/api/v1/pages/${docId}/diff?v1=1&v2=2`, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.diff).toBeArray();
  });
});
