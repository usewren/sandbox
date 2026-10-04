import { describe, it, expect, beforeAll } from "bun:test";
import { signUp, signIn } from "../setup";
import { BASE_URL, call, account, mailLink, type Account } from "./access-helpers";

// Account flows that work without real email delivery (MAIL_TRANSPORT=log: messages
// and their links are written to the log, which the helpers read), plus the generic
// 401/404/405 answers of the management API.
const stamp = Date.now();
const tag = `auth${stamp}`;

describe("sign-up and sign-in errors", () => {
  it("sign-up rejects missing fields, bad emails and short passwords", async () => {
    const cases = [
      { email: `a+${tag}@wren.dev`, name: "A" },
      { password: "secret123", name: "A" },
      { email: "not-an-email", password: "secret123", name: "A" },
      { email: `short+${tag}@wren.dev`, password: "123", name: "A" },
    ];
    for (const body of cases) {
      const r = await call("POST", "/api/auth/sign-up/email", { body });
      expect(r.status).toBe(400);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
  });

  it("sign-in with an unknown email is 401", async () => {
    const { res } = await signIn(`nobody+${tag}@wren.dev`, "secret123");
    expect(res.status).toBe(401);
  });

  it("sign-out ends the session", async () => {
    const a = await account("leaver", tag);
    expect((await call("GET", "/api/v1/me", { cookie: a.cookie })).status).toBe(200);
    expect((await call("POST", "/api/auth/sign-out", { cookie: a.cookie, body: {} })).status).toBe(200);
    expect((await call("GET", "/api/v1/me", { cookie: a.cookie })).status).toBe(401);
  });
});

describe("email confirmation", () => {
  let email: string, cookie: string;

  beforeAll(async () => {
    email = `confirm+${tag}@wren.dev`;
    ({ cookie } = await signUp(email, "secret123", "Confirm Me"));
  });

  it("sign-up sends a confirmation link; until it's used the account is unconfirmed", async () => {
    const link = await mailLink(email, /Confirm your WREN account/);
    expect(link).toContain("/api/auth/verify-email?token=");
    const s = (await call("GET", "/api/auth/get-session", { cookie })).json;
    expect(s.user.emailVerified).toBe(false);
  });

  it("an invalid confirmation token doesn't confirm anything", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/verify-email?token=bogus&callbackURL=/login?verified=1`, { redirect: "manual" });
    expect(res.status === 302 ? res.headers.get("location") : String(res.status)).toMatch(/error|401|400/);
    expect((await call("GET", "/api/auth/get-session", { cookie })).json.user.emailVerified).toBe(false);
  });

  it("following the link confirms the address", async () => {
    const link = new URL((await mailLink(email, /Confirm your WREN account/))!);
    const res = await fetch(`${BASE_URL}${link.pathname}${link.search}`, { redirect: "manual" });
    expect(res.status).toBeLessThan(400);
    expect((await call("GET", "/api/auth/get-session", { cookie })).json.user.emailVerified).toBe(true);
    // a confirmed account may list the invites sent to it
    expect((await call("GET", "/api/v1/invites/received", { cookie })).json).toEqual({ invites: [] });
  });
});

describe("password reset", () => {
  let user: Account;

  beforeAll(async () => {
    user = await account("forgetful", tag);
  });

  it("asking for a reset always answers the same, and only mails real accounts", async () => {
    const unknown = `ghost+${tag}@wren.dev`;
    const a = await call("POST", "/api/auth/request-password-reset", { body: { email: unknown, redirectTo: "/login?mode=reset" } });
    const b = await call("POST", "/api/auth/request-password-reset", { body: { email: user.email, redirectTo: "/login?mode=reset" } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json).toEqual(b.json);
    expect(await mailLink(user.email, /Reset your WREN password/)).toContain("/api/auth/reset-password/");
    expect(await mailLink(unknown, /Reset your WREN password/, 300)).toBeNull();
  });

  it("the link leads to the reset form with a token; the token sets a new password once", async () => {
    const link = new URL((await mailLink(user.email, /Reset your WREN password/))!);
    const res = await fetch(`${BASE_URL}${link.pathname}${link.search}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!, BASE_URL);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("mode")).toBe("reset");
    const token = to.searchParams.get("token")!;
    expect(token).toBeTruthy();

    expect((await call("POST", "/api/auth/reset-password", { body: { token, newPassword: "x" } })).status).toBe(400);
    expect((await call("POST", "/api/auth/reset-password", { body: { token, newPassword: "brand-new-pass" } })).status).toBe(200);
    expect((await signIn(user.email, user.password)).res.status).toBe(401);
    expect((await signIn(user.email, "brand-new-pass")).res.status).toBe(200);
    // spent
    expect((await call("POST", "/api/auth/reset-password", { body: { token, newPassword: "another-pass" } })).status).toBe(400);
  });

  it("a made-up reset token is refused", async () => {
    expect((await call("POST", "/api/auth/reset-password", { body: { token: "nope", newPassword: "whatever123" } })).status).toBe(400);
  });
});

describe("pages and sessions", () => {
  it("/login serves the sign-in page", async () => {
    const res = await fetch(`${BASE_URL}/login`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("request-password-reset");
  });

  it("/profile: HTML for a browser, JSON 401 for an API client without a session", async () => {
    const a = await account("profiled", tag);
    const html = await fetch(`${BASE_URL}/profile`, { headers: { Cookie: a.cookie, Accept: "text/html" } });
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("<html");
    const anon = await fetch(`${BASE_URL}/profile`, { headers: { Accept: "application/json" } });
    expect(anon.status).toBe(401);
  });

  it("auth works behind a TLS-terminating proxy (X-Forwarded-Proto: https)", async () => {
    const a = await account("proxied", tag);
    const r = await call("GET", "/api/auth/get-session", { cookie: a.cookie, headers: { "X-Forwarded-Proto": "https" } });
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(a.email);
  });
});

describe("generic answers of the management API", () => {
  it("every management route needs credentials", async () => {
    const routes: [string, string][] = [
      ["GET", "/api/v1/me"], ["GET", "/api/v1/keys"], ["POST", "/api/v1/keys"], ["GET", "/api/v1/org"],
      ["PUT", "/api/v1/org"], ["PUT", "/api/v1/org/slug"], ["GET", "/api/v1/org/usage"], ["GET", "/api/v1/invites"],
      ["GET", "/api/v1/invites/received"], ["POST", "/api/v1/invites/accept"], ["GET", "/api/v1/members"],
      ["GET", "/api/v1/groups"], ["GET", "/api/v1/permissions"], ["GET", "/api/v1/webhooks"],
      ["GET", "/api/v1/impersonation"], ["GET", "/api/v1/connected-apps"], ["GET", "/api/v1/collections"], ["GET", "/api/v1/_events"],
    ];
    for (const [method, path] of routes) {
      const r = await call(method, path, method === "GET" ? {} : { body: {} });
      expect(r.status).toBe(401);
      expect(r.json).toEqual({ error: "Unauthorized" });
    }
  });

  it("an expired or signed-out session cookie is treated as none", async () => {
    const r = await call("GET", "/api/v1/me", { cookie: "better-auth.session_token=forged.value" });
    expect(r.status).toBe(401);
  });

  it("unknown paths are JSON 404s", async () => {
    const a = await account("lost", tag);
    for (const path of [`/no-such-page-${stamp}`, `/api/v1/docs${stamp}/x/unknown-sub`]) {
      const r = await call("GET", path, { cookie: a.cookie });
      expect(r.status).toBe(404);
      expect(r.json.error).toBe("Not found");
    }
  });

  it("landing stats are for server operators only", async () => {
    const a = await account("curious", tag);
    expect((await call("GET", "/api/v1/landing-stats", { cookie: a.cookie })).status).toBe(403);
  });
});
