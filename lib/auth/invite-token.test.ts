import { describe, it, expect } from "vitest";
import { signInviteToken, verifyInviteToken, INVITE_TTL_SECONDS } from "./invite-token";

const base = () => ({
  invite_id: "11111111-1111-1111-1111-111111111111",
  email: "alice@example.com",
  organization_id: "22222222-2222-2222-2222-222222222222",
  role: "agent",
  exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
});

describe("invite-token", () => {
  it("sign+verify roundtrip recovers payload", () => {
    const payload = base();
    const token = signInviteToken(payload);
    const out = verifyInviteToken(token);
    expect(out).toEqual(payload);
  });

  it("returns null for expired token", () => {
    const expired = { ...base(), exp: Math.floor(Date.now() / 1000) - 10 };
    const token = signInviteToken(expired);
    expect(verifyInviteToken(token)).toBeNull();
  });

  it("returns null for tampered signature", () => {
    const token = signInviteToken(base());
    const parts = token.split(".");
    const body = parts[0]!;
    const sig = parts[1]!;
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyInviteToken(`${body}.${flipped}`)).toBeNull();
  });

  it("returns null for tampered body", () => {
    const token = signInviteToken(base());
    const parts = token.split(".");
    const body = parts[0]!;
    const sig = parts[1]!;
    const flipped = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");
    expect(verifyInviteToken(`${flipped}.${sig}`)).toBeNull();
  });

  it("returns null for malformed token (no dot)", () => {
    expect(verifyInviteToken("notatoken")).toBeNull();
  });
});
