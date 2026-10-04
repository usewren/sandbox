import { describe, it, expect } from "bun:test";
import { BASE_URL, signUp, signIn } from "../setup";

// Landing-page experiment: "/" assigns a variant per visitor and counts views,
// Admin UI opens and sign-ups per variant. The test server runs with
// WREN_OPERATORS including ops@landing.test.
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36";
const TITLES: Record<string, string> = {
  a: "WREN — Versioned JSON Storage",
  b: "Versioned tree storage",
  c: "WREN — Documents, Versions, and Trees",
  d: "Deploy your site",
  e: "WREN — Open to every agent. Private to yours.",
};
const home = (headers: Record<string, string>) => fetch(`${BASE_URL}/`, { headers, redirect: "manual" });
const variantOf = (res: Response) => res.headers.get("set-cookie")?.match(/wren_v=([a-e]);/)?.[1];

describe("landing experiment", () => {
  it("a new visitor gets a variant cookie and that variant's page; it isn't cacheable", async () => {
    const res = await home({ "User-Agent": BROWSER });
    const v = variantOf(res)!;
    expect(v).toMatch(/^[a-e]$/);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=7776000");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("vary")).toContain("Cookie");
    expect(await res.text()).toContain(TITLES[v]);
  });

  it("a returning visitor keeps their variant", async () => {
    for (const v of ["a", "e"]) {
      const res = await home({ "User-Agent": BROWSER, Cookie: `wren_v=${v}` });
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.text()).toContain(TITLES[v]);
    }
  });

  it("crawlers always get the default page and no cookie", async () => {
    const res = await home({ "User-Agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toContain(TITLES.c);
  });

  it("an unknown cookie value is replaced", async () => {
    const res = await home({ "User-Agent": BROWSER, Cookie: "wren_v=zz" });
    expect(variantOf(res)).toMatch(/^[a-e]$/);
  });

  it("/e serves the agents-first page", async () => {
    expect(await (await fetch(`${BASE_URL}/e`)).text()).toContain(TITLES.e);
  });

  it("counts views, the first Admin UI open and sign-ups per variant; operators only", async () => {
    const stamp = Date.now();
    await signUp(`ops@landing.test`, "secret123", "Ops");
    const ops = (await signIn(`ops@landing.test`, "secret123")).cookie;
    const stats = async () => (await (await fetch(`${BASE_URL}/api/v1/landing-stats?days=1`, { headers: { Cookie: ops, Origin: BASE_URL } })).json()).variants
      .find((x: any) => x.variant === "e");
    const before = await stats();

    const C = { "User-Agent": BROWSER, Cookie: "wren_v=e" };
    await home(C);
    const admin1 = await fetch(`${BASE_URL}/admin/`, { headers: C });
    expect(admin1.headers.get("set-cookie")).toContain("wren_va=1");
    await fetch(`${BASE_URL}/admin/`, { headers: { ...C, Cookie: "wren_v=e; wren_va=1" } }); // second open: not counted
    await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST", headers: { ...C, "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ email: `visitor${stamp}@landing.test`, password: "secret123", name: "Visitor" }),
    });

    const after = await stats();
    expect(after.view - before.view).toBe(1);
    expect(after.admin - before.admin).toBe(1);
    expect(after.signup - before.signup).toBe(1);
    expect(after.active).toBe(true);

    const other = (await signIn(`visitor${stamp}@landing.test`, "secret123")).cookie;
    expect((await fetch(`${BASE_URL}/api/v1/landing-stats`, { headers: { Cookie: other, Origin: BASE_URL } })).status).toBe(403);
    expect((await fetch(`${BASE_URL}/api/v1/landing-stats`)).status).toBe(401);
  });
});
