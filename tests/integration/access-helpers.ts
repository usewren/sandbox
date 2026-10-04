// Shared helpers for the access-*.test.ts files (access control, admin, security).
// Not a test file itself: bun only runs *.test.ts.
import postgres from "postgres";
import { BASE_URL, signUp, signIn } from "../setup";

export { BASE_URL };

export type Res = { status: number; json: any; text: string; headers: Headers };
export type Opts = { cookie?: string; key?: string; body?: unknown; headers?: Record<string, string>; origin?: string | null };

/** One request with JSON in and out; Origin defaults to the server's own (a trusted origin). */
export async function call(method: string, path: string, opts: Opts = {}): Promise<Res> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.origin === null ? {} : { Origin: opts.origin ?? BASE_URL }),
    ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
    ...opts.headers,
  };
  const res = await fetch(`${BASE_URL}${path}`, {
    method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: "manual",
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

export type Account = { email: string; password: string; cookie: string; id: string; slug: string };

/** Sign up and sign in a fresh account; its id is also its own org's id. */
export async function account(name: string, tag: string): Promise<Account> {
  const email = `${name}+${tag}@wren.dev`;
  const password = "secret123";
  await signUp(email, password, name);
  const { cookie } = await signIn(email, password);
  const me = (await call("GET", "/api/v1/me", { cookie })).json;
  return { email, password, cookie, id: me.user.id, slug: me.org.slug };
}

/** Owner invites `who` and `who` accepts with the link. */
export async function invite(owner: { cookie: string }, who: { email: string; cookie: string }, role = "member", groupIds: string[] = []) {
  const inv = await call("POST", "/api/v1/invites", { cookie: owner.cookie, body: { email: who.email, role, groupIds } });
  const acc = await call("POST", "/api/v1/invites/accept", { cookie: who.cookie, body: { token: inv.json.token } });
  return { inv, acc };
}

/** Point a browser session at another org (session-only setting). */
export function useOrg(user: { cookie: string }, orgId: string) {
  return call("PUT", "/api/v1/org", { cookie: user.cookie, body: { orgId } });
}

export async function groupIds(owner: { cookie: string }): Promise<{ editors: string; viewers: string }> {
  const groups = (await call("GET", "/api/v1/groups", { cookie: owner.cookie })).json.groups;
  return {
    editors: groups.find((g: any) => g.name === "Editors").id,
    viewers: groups.find((g: any) => g.name === "Viewers").id,
  };
}

export async function newKey(cookie: string, name = "k"): Promise<{ id: string; key: string }> {
  const r = await call("POST", "/api/v1/keys", { cookie, body: { name } });
  return { id: r.json.id, key: r.json.key };
}

export function rule(cookie: string, body: Record<string, unknown>) {
  return call("POST", "/api/v1/permissions", { cookie, body });
}

/** Poll until `fn` returns a truthy value (or the time is up); returns the last value. */
export async function until<T>(fn: () => Promise<T> | T, ms = 5000, every = 50): Promise<T> {
  const t0 = Date.now();
  let v = await fn();
  while (!v && Date.now() - t0 < ms) { await Bun.sleep(every); v = await fn(); }
  return v;
}

// Direct database access, for what the API doesn't expose (the access log, the
// impersonation columns on labels/paths) and to age a key or invite past its expiry.
let _db: ReturnType<typeof postgres> | null = null;
export function db() {
  _db ??= postgres(process.env.DATABASE_URL ?? "postgres://wren:wren@localhost:5432/wren", { max: 2, onnotice: () => {} });
  return _db;
}
export const tenant = (orgId: string) => "tenant_" + orgId.toLowerCase().replace(/[^a-z0-9]/g, "_");

// The test server runs in this process with MAIL_TRANSPORT=log, so outgoing mail is
// written with console.log. Keep a copy to pick confirmation and reset links out of it.
const g = globalThis as any;
if (!g.__wrenMailLog) {
  g.__wrenMailLog = [] as string[];
  const orig = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const s = args.map(String).join(" ");
    if (s.startsWith("[mail:log]")) { g.__wrenMailLog.push(s); return; }
    orig(...args);
  };
}

/** The first link in the newest mail to `to` whose subject matches. */
export async function mailLink(to: string, subject: RegExp, ms = 5000): Promise<string | null> {
  return until(() => {
    const mails = (g.__wrenMailLog as string[]).filter(m => m.includes(`to=${to} `) && subject.test(m));
    const last = mails[mails.length - 1];
    return last?.match(/https?:\/\/\S+/)?.[0] ?? null;
  }, ms);
}

/** Confirm an account's email through the link in its confirmation mail. */
export async function verifyEmail(email: string): Promise<number> {
  const link = await mailLink(email, /Confirm your WREN account/);
  if (!link) throw new Error(`no confirmation mail for ${email}`);
  const u = new URL(link);
  const res = await fetch(`${BASE_URL}${u.pathname}${u.search}`, { redirect: "manual" });
  return res.status;
}
