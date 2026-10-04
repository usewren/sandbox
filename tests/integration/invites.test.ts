import { describe, it, expect, beforeAll } from "bun:test";
import { BASE_URL, post, get, signUp, signIn } from "../setup";

const stamp = Date.now();
const owner = `owner+${stamp}@wren.dev`;
const invitee = `invitee+${stamp}@wren.dev`;
const stranger = `stranger+${stamp}@wren.dev`;
let ownerCookie: string;
let token: string;
let inviteId: string;

async function account(email: string) {
  await signUp(email, "secret123", email);
  return (await signIn(email, "secret123")).cookie;
}

beforeAll(async () => {
  ownerCookie = await account(owner);
  const inv = await (await post("/api/v1/invites", { email: invitee, role: "member" }, ownerCookie)).json();
  token = inv.token;
  inviteId = inv.id;
});

describe("invites are bound to the invited email", () => {
  it("someone else holding the link can't accept it", async () => {
    const c = await account(stranger);
    const res = await post("/api/v1/invites/accept", { token }, c);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain(invitee);
  });

  it("an unconfirmed account sees no received invites and can't accept by id", async () => {
    // registering the invited address is easy without confirmation, so the
    // id-based path (no link) must require a confirmed email
    const c = await account(invitee);
    const list = await (await get("/api/v1/invites/received", c)).json();
    expect(list.invites).toEqual([]);
    expect(list.emailVerified).toBe(false);
    const res = await post(`/api/v1/invites/${inviteId}/accept`, {}, c);
    expect(res.status).toBe(403);
  });

  it("the invited address accepts with the link", async () => {
    const c = (await signIn(invitee, "secret123")).cookie;
    const res = await post("/api/v1/invites/accept", { token }, c);
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(true);
  });

  it("matching ignores letter case", async () => {
    const upper = `Case+${stamp}@Wren.dev`;
    const inv = await (await post("/api/v1/invites", { email: upper }, ownerCookie)).json();
    const c = await account(upper.toLowerCase());
    expect((await post("/api/v1/invites/accept", { token: inv.token }, c)).status).toBe(200);
  });
});
