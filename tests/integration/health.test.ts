import { describe, it, expect } from "bun:test";
import { BASE_URL } from "../setup";

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
