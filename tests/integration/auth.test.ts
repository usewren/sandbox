import { describe, it, expect } from "bun:test";
import { BASE_URL, post, get, signUp, signIn } from "../setup";

const email = `test+${Date.now()}@wren.dev`;
const password = "secret123";
const name = "Test User";

describe("auth", () => {
  describe("POST /api/auth/sign-up/email", () => {
    it("creates a user and returns a session", async () => {
      const { res } = await signUp(email, password, name);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe(email);
      expect(body.user.role).toBe("viewer");
      expect(body.token).toBeTruthy();
    });

    it("rejects duplicate email", async () => {
      await signUp(email, password, name);
      const { res } = await signUp(email, password, name);
      expect(res.status).not.toBe(200);
    });
  });

  describe("POST /api/auth/sign-in/email", () => {
    it("returns a session for valid credentials", async () => {
      await signUp(email, password, name);
      const { res } = await signIn(email, password);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe(email);
    });

    it("rejects invalid password", async () => {
      await signUp(email, password, name);
      const { res } = await signIn(email, "wrong");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/auth/get-session", () => {
    it("returns user when authenticated", async () => {
      await signUp(email, password, name);
      const { cookie } = await signIn(email, password);
      const res = await get("/api/auth/get-session", cookie);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe(email);
    });

    it("returns null when unauthenticated", async () => {
      const res = await get("/api/auth/get-session");
      const body = await res.json();
      expect(body).toBeNull();
    });
  });

  describe("GET /profile", () => {
    it("redirects to login when unauthenticated", async () => {
      const res = await fetch(`${BASE_URL}/profile`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login");
    });

    it("returns user profile when authenticated", async () => {
      await signUp(email, password, name);
      const { cookie } = await signIn(email, password);
      const res = await get("/profile", cookie);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe(email);
    });
  });
});
