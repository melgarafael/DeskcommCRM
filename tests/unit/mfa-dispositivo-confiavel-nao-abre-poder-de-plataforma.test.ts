/**
 * A FIAÇÃO de `agindoPeloPoderDePlataforma` dentro de `mfaEmDivida`.
 *
 * Todo teste que passa por `mfaEmDivida` mocka `@/lib/auth/poder-de-plataforma`
 * para responder `false` — então a linha que cobra o código do platform admin
 * agindo numa empresa onde não é admin podia sumir com a suíte verde. É ela que
 * cobre as server actions e rotas que autorizam por `escreveComoPlatformAdmin`
 * e perguntam `mfaEmDivida` sem passar pelo atalho de `requireRole`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { agindoPeloPoderDePlataforma } from "@/lib/auth/poder-de-plataforma";
import { mfaEmDivida } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/poder-de-plataforma", () => ({ agindoPeloPoderDePlataforma: vi.fn() }));

function sessaoAal1ComFatorReconhecidaPeloBanco() {
  return {
    rpc: vi.fn(async (nome: string) => ({ data: nome === "fn_session_mfa_proven", error: null })),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: "u1", factors: [{ id: "f1", factor_type: "totp", status: "verified" }] } },
        error: null,
      })),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal1", nextLevel: "aal2" },
          error: null,
        })),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createClient).mockResolvedValue(
    sessaoAal1ComFatorReconhecidaPeloBanco() as unknown as Awaited<ReturnType<typeof createClient>>,
  );
});

describe("mfaEmDivida — dispositivo confiável e poder de plataforma", () => {
  it("CONTROLE: fora do poder de plataforma, a sessão que o banco reconhece não deve o código", async () => {
    vi.mocked(agindoPeloPoderDePlataforma).mockResolvedValue(false);
    expect(await mfaEmDivida()).toBe(false);
  });

  it("agindo pelo poder de plataforma, a mesma sessão DEVE o código", async () => {
    vi.mocked(agindoPeloPoderDePlataforma).mockResolvedValue(true);
    expect(await mfaEmDivida()).toBe(true);
  });
});
