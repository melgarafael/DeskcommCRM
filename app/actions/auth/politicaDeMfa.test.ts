/**
 * Mudar a exigência de verificação da EMPRESA é escrita sensível: quem tem fator
 * cadastrado precisa tê-lo provado nesta sessão (`aal2`), como nas rotas.
 *
 * `mfaEmDivida`, `isMfaEnrolled` e `sessionAal` são os REAIS, sobre um cliente
 * Supabase stub — mockar `mfaEmDivida` seria testar o mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as AuthServer from "@/lib/auth/server";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", async (importOriginal) => {
  const real = await importOriginal<typeof AuthServer>();
  return { ...real, loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
const deps = vi.hoisted(() => ({ update: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: {} }, error: null }) }) }),
      update: (v: unknown) => {
        deps.update(v);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

import { definirExigenciaDeMfa } from "./politicaDeMfa";

function preparar({ temFator, aal }: { temFator: boolean; aal: "aal1" | "aal2" }): void {
  vi.mocked(loadAuthUser).mockResolvedValue({ id: "eu", is_platform_admin: false } as never);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: "org", role: "admin" } as never);
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      mfa: {
        listFactors: async () => ({ data: { totp: temFator ? [{ id: "f1", status: "verified" }] : [] }, error: null }),
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: aal }, error: null }),
      },
    },
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("definirExigenciaDeMfa", () => {
  it.each([true, false])("admin com fator e sessão aal1 NÃO muda a política (exigir=%s)", async (exigir) => {
    preparar({ temFator: true, aal: "aal1" });
    expect(await definirExigenciaDeMfa(exigir)).toEqual({
      ok: false,
      erro: "Confirme a verificação em duas etapas nesta sessão.",
    });
    expect(deps.update).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("admin com fator provado (aal2) muda", async () => {
    preparar({ temFator: true, aal: "aal2" });
    // `true` sobre settings vazias é MUDANÇA (ninguém → administradores): desde
    // o #2163, regravar o valor atual não escreve nem audita.
    expect(await definirExigenciaDeMfa(true)).toEqual({ ok: true });
    expect(deps.update).toHaveBeenCalledTimes(1);
  });

  // MFA é opcional: quem não cadastrou fator não tem o que provar.
  it("admin sem fator muda", async () => {
    preparar({ temFator: false, aal: "aal1" });
    expect(await definirExigenciaDeMfa(true)).toEqual({ ok: true });
    expect(deps.update).toHaveBeenCalledTimes(1);
  });
});
