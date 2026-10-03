/**
 * A leitura dos fatores de MFA falha FECHADA.
 *
 * O `listFactors()` do auth-js (2.117.x) não lança quando o `getUser()` interno
 * falha: ele DEVOLVE `{ data: null, error }`. `isMfaEnrolled()` lia só `data`,
 * respondia "não tem fator", e `mfaEmDivida()` liberava a sessão `aal1` de quem
 * TEM fator cadastrado.
 *
 * O stub reproduz a forma REAL da falha — um valor devolvido, não uma promessa
 * rejeitada. `mockRejectedValue` aqui passaria mesmo sem o conserto, porque a
 * rejeição já propagava; o defeito mora justamente no erro que chega como dado.
 *
 * Arquivo próprio (e não `require-role-mfa.test.ts`) para não colidir com o PR
 * que mexe naquele arquivo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { isMfaEnrolled, loadAuthUser, mfaEmDivida, orgAtivaSemPortao, resolveActiveOrg } from "@/lib/auth/server";
import type { AuthUser } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/server")>();
  return { ...real, loadAuthUser: vi.fn(), resolveActiveOrg: vi.fn(), orgAtivaSemPortao: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

const FALHA_DO_GETUSER = Object.assign(new Error("fetch failed"), { name: "AuthRetryableFetchError", status: 0 });

function preparar(listFactors: () => Promise<unknown>): void {
  vi.mocked(loadAuthUser).mockResolvedValue({
    id: USER_ID,
    email: "admin@teste.local",
    is_platform_admin: false,
    organizations: [],
  } as unknown as AuthUser);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "admin" });
  vi.mocked(orgAtivaSemPortao).mockResolvedValue({ orgId: ORG_ID, name: "Org", role: "admin", org_status: "active" });
  vi.mocked(createClient).mockResolvedValue({
    rpc: vi.fn(async () => ({ data: "admin", error: null })),
    auth: {
      mfa: {
        listFactors: vi.fn(listFactors),
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal1", nextLevel: "aal2" },
          error: null,
        })),
      },
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("leitura dos fatores de MFA — falha devolvida não vira 'sem fator'", () => {
  it("listFactors DEVOLVE {data:null, error}: isMfaEnrolled lança em vez de responder false", async () => {
    preparar(async () => ({ data: null, error: FALHA_DO_GETUSER }));
    await expect(isMfaEnrolled()).rejects.toBe(FALHA_DO_GETUSER);
  });

  it("…e mfaEmDivida não responde 'sem dívida' — as rotas que a chamam direto não liberam", async () => {
    preparar(async () => ({ data: null, error: FALHA_DO_GETUSER }));
    await expect(mfaEmDivida()).rejects.toBe(FALHA_DO_GETUSER);
  });

  it("…e requireRole NÃO devolve ok:true para a sessão aal1", async () => {
    preparar(async () => ({ data: null, error: FALHA_DO_GETUSER }));
    const desfecho = await requireRole("admin", { requestId: "req-1" }).then(
      (r) => (r.ok ? "liberou" : `negou ${r.response.status}`),
      () => "lançou",
    );
    expect(desfecho).not.toBe("liberou");
  });

  it("CONTROLE: leitura bem-sucedida com fator e sessão aal1 segue barrada com 403", async () => {
    preparar(async () => ({ data: { totp: [{ id: "f1", status: "verified" }] }, error: null }));
    const r = await requireRole("admin", { requestId: "req-2" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it("CONTROLE: leitura bem-sucedida SEM fator passa (quem não cadastrou precisa alcançar o cadastro)", async () => {
    preparar(async () => ({ data: { totp: [] }, error: null }));
    const r = await requireRole("admin", { requestId: "req-3" });
    expect(r.ok).toBe(true);
  });
});
