import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, signUp, signIn } from "../setup";

// The test server runs with BETTER_AUTH_URL; generated public links must use it
// (behind a TLS-terminating proxy the request URL would otherwise be http://).
const configured = (process.env.EXPECT_PUBLIC_BASE ?? "").replace(/\/$/, "");

beforeAll(async () => {
  const email = `links+${Date.now()}@wren.dev`;
  await signUp(email, "secret123", "Links");
  const { cookie } = await signIn(email, "secret123");
  await post("/api/v1/permissions", { principal: "*", resource: "collection:pub", access: "read" }, cookie);
});

describe("generated links", () => {
  it("/health reports a build identifier", async () => {
    const h = await (await fetch(`${BASE_URL}/health`)).json();
    expect(typeof h.build).toBe("string");
    expect(h.build).not.toBe("20260414b");
  });

  it("/api/v1/projects org url points at a real route", async () => {
    const { projects } = await (await fetch(`${BASE_URL}/api/v1/projects`)).json();
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      expect(p.url).toEndWith(`/orgs/${p.slug}/llms.txt`);
      const path = new URL(p.url).pathname;
      expect((await fetch(`${BASE_URL}${path}`)).status).toBe(200);
      if (configured) expect(p.url.startsWith(configured)).toBe(true);
    }
  });

  it("sitemap uses the configured public base", async () => {
    if (!configured) return;
    const xml = await (await fetch(`${BASE_URL}/sitemap.xml`)).text();
    expect(xml).toContain(`<loc>${configured}/</loc>`);
  });
});
