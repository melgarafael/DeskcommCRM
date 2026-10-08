/**
 * As chaves da cobrança do revendedor têm escritora própria (spec §7a, §10): a
 * Conexão confere a chave com o provedor, registra o webhook e recusa trocar o
 * provedor de quem tem assinatura viva. As ações genéricas só olham `controle`
 * — sem esta recusa, trocariam a chave Stripe sem nada disso.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ gravar: vi.fn(), voltar: vi.fn(), audit: vi.fn() }));

// A ação passa por `escritaDeAdminOuRecusa` (cerca admin-escrita-exige-scope-full, regra D:
// arquivo "use server" não chama `requirePlatformAdminEscrita` direto).
vi.mock("@/lib/auth/escritaDeAdminOuRecusa", () => ({
  escritaDeAdminOuRecusa: async () => ({ ok: true, ctx: { user: { id: "dono" } } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/instalacao/config", () => ({
  gravarPelaTela: deps.gravar,
  voltarAoAmbiente: deps.voltar,
  estadoParaTela: async (chave: string) => ({
    chave, fonte: "banco", configurado: true, last4: null, ehSegredo: false, valorVisivel: null,
  }),
}));

import { CATALOGO_DA_INSTALACAO } from "@/lib/instalacao/catalogo";

import { salvarConfiguracaoDaInstalacao, voltarConfiguracaoAoPadrao } from "./salvarConfiguracaoDaInstalacao";

const DA_COBRANCA = CATALOGO_DA_INSTALACAO.filter((c) => c.telaDona === "cobranca").map((c) => c.chave);

beforeEach(() => {
  vi.clearAllMocks();
  deps.gravar.mockResolvedValue({ ok: true });
  deps.voltar.mockResolvedValue({ ok: true });
});

describe("as chaves da cobrança só se escrevem pela tela de Cobrança", () => {
  it("controle: a sonda enxerga as quatro chaves da cobrança", () => {
    expect(DA_COBRANCA).toHaveLength(4);
  });

  it.each(DA_COBRANCA)("salvar %s pela ação genérica é recusado sem gravar nem auditar", async (chave) => {
    const r = await salvarConfiguracaoDaInstalacao(chave, "valor-qualquer-1234");
    expect(r).toEqual({ ok: false, erro: "Esta configuração não pode ser alterada por aqui." });
    expect(deps.gravar).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it.each(DA_COBRANCA)("voltar %s ao padrão pela ação genérica é recusado sem apagar", async (chave) => {
    const r = await voltarConfiguracaoAoPadrao(chave);
    expect(r).toEqual({ ok: false, erro: "Esta configuração não pode ser alterada por aqui." });
    expect(deps.voltar).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("controle: uma chave de outra tela continua gravando", async () => {
    const r = await salvarConfiguracaoDaInstalacao("SUPPORT_EMAIL", "ajuda@exemplo.com");
    expect(r.ok).toBe(true);
    expect(deps.gravar).toHaveBeenCalledWith("SUPPORT_EMAIL", "ajuda@exemplo.com", expect.objectContaining({ ehSegredo: false }));
  });
});
