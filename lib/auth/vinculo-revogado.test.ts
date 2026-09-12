import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { acessoFoiRevogado } from "@/lib/auth/vinculo-revogado";
import { createClient } from "@/lib/supabase/server";

/**
 * REVOGAR ACESSO NÃO PODE VIRAR CONVITE PARA ABRIR UMA EMPRESA.
 *
 * `loadAuthUser` filtra `.is("revoked_at", null)` — certo para montar o menu, e
 * é o que joga fora a informação que distingue dois estados opostos:
 *
 *  - nunca teve organização  → `/get-started` é o caminho legítimo
 *  - teve e foi revogada     → precisa de tela que diga isso
 *
 * Medido em 2026-09-10 numa instalação real: o revogado via a casca vazia com
 * "Configure sua organização" e só não criou uma porque tinha `invite_token`
 * residual no `user_metadata` — acidente, não guarda.
 *
 * O terceiro caso é o que mais importa: esta função roda dentro de
 * `app/app/layout.tsx`, e lançar ali é 500 em TODAS as telas. Erro de consulta
 * degrada para `false`, que é o comportamento anterior a ela existir.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const USER = "11111111-1111-4111-8111-111111111111";

function bancoQue(resposta: { data: unknown[] | null; error: unknown }) {
  const limit = vi.fn(async () => resposta);
  const not = vi.fn(() => ({ limit }));
  const eq = vi.fn(() => ({ not }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  vi.mocked(createClient).mockResolvedValue({ from } as unknown as Awaited<
    ReturnType<typeof createClient>
  >);
  return { from, select, eq, not, limit };
}

describe("acessoFoiRevogado", () => {
  beforeEach(() => vi.clearAllMocks());

  it("acha um vínculo revogado", async () => {
    const espiao = bancoQue({ data: [{ id: "m1" }], error: null });
    await expect(acessoFoiRevogado(USER)).resolves.toBe(true);
    // O filtro pelo dono é explícito, não confiado só à RLS.
    expect(espiao.eq).toHaveBeenCalledWith("user_id", USER);
    expect(espiao.not).toHaveBeenCalledWith("revoked_at", "is", null);
  });

  it("sem vínculo revogado devolve false — quem nunca teve segue para /get-started", async () => {
    bancoQue({ data: [], error: null });
    await expect(acessoFoiRevogado(USER)).resolves.toBe(false);
  });

  it("erro de consulta NÃO derruba a tela: degrada para o comportamento anterior", async () => {
    bancoQue({ data: null, error: { message: "connection reset" } });
    await expect(acessoFoiRevogado(USER)).resolves.toBe(false);
  });

  it("exceção também degrada — o layout inteiro depende disso", async () => {
    vi.mocked(createClient).mockRejectedValue(new Error("boom"));
    await expect(acessoFoiRevogado(USER)).resolves.toBe(false);
  });
});

describe("a recusa por revogação tem texto na tela", () => {
  // Mesmo raciocínio do caso irmão em `auth-confirm-recusa-nomeia-a-causa`:
  // sem texto, `access_revoked` chega a um formulário que não o conhece e a
  // recusa fica MUDA — pior que a mensagem errada que havia antes.
  it("o formulário conhece o código `access_revoked`", () => {
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "components/auth/RecoverOrganizationForm.tsx"),
      "utf8",
    );
    expect(fonte).toContain("access_revoked");
    expect(fonte).toContain("não devolve o acesso");
  });

  it("a ação recusa antes de olhar convite — senão o motivo sai errado", () => {
    const fonte = fs.readFileSync(
      path.join(process.cwd(), "app/actions/auth/recoverOrganization.ts"),
      "utf8",
    );
    const posRevogado = fonte.indexOf("acessoFoiRevogado");
    const posConvite = fonte.indexOf("decidirConviteDoSignup(authUser)");
    expect(posRevogado).toBeGreaterThan(-1);
    expect(posConvite).toBeGreaterThan(-1);
    expect(posRevogado).toBeLessThan(posConvite);
  });
});
