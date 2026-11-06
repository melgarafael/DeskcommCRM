/**
 * Códigos de recuperação novos desligam o fator pela porta da recuperação
 * (`useRecoveryCode` remove os fatores). Por isso emiti-los exige o código
 * provado NESTA sessão (`aal2`): uma sessão só com a senha, ou de um
 * dispositivo confiável (#3200), recebe `mfa_required` e nada é gravado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ aal: "aal1" as "aal1" | "aal2", escritas: 0 }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/server", () => ({ sessionAal: async () => h.aal }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "11111111-1111-4111-8111-111111111111" } } }),
      mfa: { listFactors: async () => ({ data: { totp: [{ status: "verified" }] } }) },
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => {
  const tabela = () => ({
    delete: () => ({
      eq: async () => {
        h.escritas++;
        return { error: null };
      },
    }),
    insert: async () => {
      h.escritas++;
      return { error: null };
    },
  });
  return { createAdminClient: () => ({ from: tabela }) };
});

import { regenerateRecoveryCodes } from "./regenerateRecoveryCodes";

beforeEach(() => {
  vi.stubEnv("INTERNAL_SECRET", "segredo-da-instalacao");
  h.escritas = 0;
});

describe("regenerar códigos de recuperação exige o código desta sessão", () => {
  it("sessão aal1 (senha ou dispositivo confiável): mfa_required e nada é gravado", async () => {
    h.aal = "aal1";
    await expect(regenerateRecoveryCodes()).resolves.toEqual({ ok: false, error: "mfa_required" });
    expect(h.escritas).toBe(0);
  });

  it("CONTROLE: com o código provado (aal2), emite 10 códigos", async () => {
    h.aal = "aal2";
    const r = await regenerateRecoveryCodes();
    expect(r.ok && r.recovery_codes.length).toBe(10);
    expect(h.escritas).toBe(2);
  });
});
