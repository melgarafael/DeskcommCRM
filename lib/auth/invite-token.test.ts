import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { signInviteToken, verifyInviteToken, INVITE_TTL_SECONDS } from "./invite-token";

beforeAll(() => {
  vi.stubEnv("INVITE_TOKEN_SECRET", "segredo-de-teste-só-para-este-arquivo");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const base = () => ({
  invite_id: "11111111-1111-4111-8111-111111111111",
  email: "alice@example.com",
  organization_id: "22222222-2222-4222-8222-222222222222",
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

  it("rejects signed machine/unknown roles and malformed identities", () => {
    for (const role of ["ai_operator", "superadmin", ""]) {
      expect(verifyInviteToken(signInviteToken({ ...base(), role }))).toBeNull();
    }
    expect(verifyInviteToken(signInviteToken({ ...base(), organization_id: "not-uuid" }))).toBeNull();
  });
  it("preserves signed inviter and issuance time", () => {
    const p = { ...base(), invited_by: "33333333-3333-4333-8333-333333333333", iat: Math.floor(Date.now()/1000) };
    expect(verifyInviteToken(signInviteToken(p))).toEqual(p);
  });

describe("invite-token fail-closed", () => {
  it("lança em vez de assinar quando não há segredo configurado", () => {
    vi.stubEnv("INVITE_TOKEN_SECRET", "");
    vi.stubEnv("INTERNAL_SECRET", "");
    const payload = {
      invite_id: "11111111-1111-4111-8111-111111111111",
      email: "alice@example.com",
      organization_id: "22222222-2222-4222-8222-222222222222",
      role: "agent",
      exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
    };
    expect(() => signInviteToken(payload)).toThrow(/não configurado/);
    // Restaura o segredo de teste para os demais testes deste arquivo.
    vi.stubEnv("INVITE_TOKEN_SECRET", "segredo-de-teste-só-para-este-arquivo");
    vi.stubEnv("INTERNAL_SECRET", "");
  });
});
