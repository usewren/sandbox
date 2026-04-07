import { beforeAll, afterAll } from "bun:test";

// Default to the running Docker container; override with TEST_BASE_URL env var
export const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:4000";
export const TEST_DB = "postgres://wren:wren@localhost:5432/wren_test";

export async function post(path: string, body: unknown, cookie?: string) {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Origin": BASE_URL,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export async function get(path: string, cookie?: string) {
  return fetch(`${BASE_URL}${path}`, {
    headers: {
      "Accept": "application/json",
      "Origin": BASE_URL,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

export async function signUp(email: string, password: string, name: string) {
  const res = await post("/api/auth/sign-up/email", { email, password, name });
  const cookie = decodeURIComponent(res.headers.get("set-cookie")?.split(";")[0] ?? "");
  return { res, cookie };
}

export async function signIn(email: string, password: string) {
  const res = await post("/api/auth/sign-in/email", { email, password });
  const cookie = decodeURIComponent(res.headers.get("set-cookie")?.split(";")[0] ?? "");
  return { res, cookie };
}
