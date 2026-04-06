import { describe, it, expect } from "bun:test";

// Unit tests for route segment parsing logic — no server needed

function stripApiV1(pathname: string): string {
  return pathname.startsWith("/api/v1/") ? pathname.slice(7) : pathname;
}

function parseSegments(pathname: string) {
  const apiPath = stripApiV1(pathname);
  const segments = apiPath.replace(/^\//, "").split("/");
  const [collection, id, sub, version] = segments;
  return { collection, id, sub, version };
}

describe("api/v1 prefix stripping", () => {
  it("strips /api/v1 prefix", () => {
    expect(stripApiV1("/api/v1/pages")).toBe("/pages");
    expect(stripApiV1("/api/v1/pages/123")).toBe("/pages/123");
  });

  it("leaves non-api/v1 paths untouched", () => {
    expect(stripApiV1("/health")).toBe("/health");
    expect(stripApiV1("/api/auth/sign-in/email")).toBe("/api/auth/sign-in/email");
    expect(stripApiV1("/robots.txt")).toBe("/robots.txt");
  });
});

describe("route segment parsing", () => {
  it("parses collection route", () => {
    const { collection, id } = parseSegments("/api/v1/pages");
    expect(collection).toBe("pages");
    expect(id).toBeUndefined();
  });

  it("parses document route", () => {
    const { collection, id, sub } = parseSegments("/api/v1/pages/123");
    expect(collection).toBe("pages");
    expect(id).toBe("123");
    expect(sub).toBeUndefined();
  });

  it("parses versions route", () => {
    const { collection, id, sub } = parseSegments("/api/v1/pages/123/versions");
    expect(collection).toBe("pages");
    expect(id).toBe("123");
    expect(sub).toBe("versions");
  });

  it("parses specific version route", () => {
    const { collection, id, sub, version } = parseSegments("/api/v1/pages/123/versions/5");
    expect(collection).toBe("pages");
    expect(id).toBe("123");
    expect(sub).toBe("versions");
    expect(version).toBe("5");
  });

  it("parses rollback route", () => {
    const { sub, version } = parseSegments("/api/v1/pages/123/rollback/3");
    expect(sub).toBe("rollback");
    expect(version).toBe("3");
  });

  it("parses diff route", () => {
    const { sub } = parseSegments("/api/v1/pages/123/diff");
    expect(sub).toBe("diff");
  });

  it("parses management routes (keys, members, etc.)", () => {
    const { collection } = parseSegments("/api/v1/keys");
    expect(collection).toBe("keys");
    const { collection: members } = parseSegments("/api/v1/members");
    expect(members).toBe("members");
  });
});
