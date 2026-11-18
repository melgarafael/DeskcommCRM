/**
 * `conexao-um-clique` — as decisões do fluxo, com provedor, banco e cifra dublados.
 *
 * O que este arquivo prova:
 *   1. sem chave da instalação, sem um clique; conexão por chave própria ativa
 *      não é sobrescrita por baixo;
 *   2. a VAGA do plano é conferida antes de qualquer chamada ao provedor — sem
 *      ela, a pessoa terminaria o cadastro na Meta e o número entraria na
 *      fatura da instalação para o CRM recusar no fim;
 *   3. o perfil que já tem o número conclui sem passar pela Meta;
 *   4. a volta só conclui com o estado DESTA organização, no prazo, com o
 *      perfil assinado e a conta confirmada pelo provedor naquele perfil;
 *   5. a conexão entra no webhook ÚNICO da instalação (nunca uma assinatura
 *      por número), e reconectar uma sessão que guarda outra assinatura
 *      entrega essa assinatura para ser apagada (`legado`);
 *   6. o perfil e o webhook levam a marca da INSTALAÇÃO no nome; sem marca
 *      própria, o perfil fica sem prefixo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Limites from "@/lib/cobranca/limites";

import type * as ConexaoPelaInstalacao from "./zernio/conexao-pela-instalacao";

const h = vi.hoisted(() => ({
  chave: vi.fn(),
  find: vi.fn(),
  save: vi.fn(),
  segredoAtual: vi.fn(),
  registrar: vi.fn(),
  garantirPerfil: vi.fn(),
  whatsappDoPerfil: vi.fn(),
  urlDaPagina: vi.fn(),
  contaNoPerfil: vi.fn(),
  limite: vi.fn(),
  marca: vi.fn(),
}));

vi.mock("./zernio/credentials", () => ({ chaveDaInstalacao: h.chave }));
vi.mock("./connect", () => ({
  PARTNER_CHANNEL_LABEL: "Parceiro",
  findPartnerSession: h.find,
  savePartnerSession: h.save,
  segredoAtualDoWebhook: h.segredoAtual,
  registrarNoWebhookDaInstalacao: h.registrar,
}));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: h.marca }));
vi.mock("./zernio/conexao-pela-instalacao", async (original) => ({
  ...(await original<typeof ConexaoPelaInstalacao>()),
  garantirPerfil: h.garantirPerfil,
  whatsappDoPerfil: h.whatsappDoPerfil,
  urlDaPaginaDeConexao: h.urlDaPagina,
  contaConectadaNoPerfil: h.contaNoPerfil,
}));
vi.mock("@/lib/cobranca/limites", async (original) => ({
  ...(await original<typeof Limites>()),
  lerLimiteDoPlano: h.limite,
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: async (_db: unknown, v: string) => `cifrado:${v}`,
}));

import {
  ErroDaConexaoUmClique,
  concluirConexaoUmClique,
  iniciarConexaoUmClique,
  type ContextoDaConexao,
} from "./conexao-um-clique";
import { emitirEstadoDaVolta, verificarEstadoDaVolta } from "./estado-da-volta";

const ORG = "11111111-1111-4111-8111-111111111111";
const PERFIL = "a".repeat(24);
const CONTA = "b".repeat(24);
const SEGREDO = "segredo-interno-de-teste-123";
const AGORA = new Date("2026-10-20T20:00:00Z");
const ctx: ContextoDaConexao = {
  organizationId: ORG,
  organizationNome: "Loja da Ana",
  userId: "22222222-2222-4222-8222-222222222222",
  idioma: "es",
  segredo: SEGREDO,
  agora: AGORA,
  publicBase: "https://crm.exemplo.com",
};
const opcoes = { coexistencia: true, marca: "Marca Exemplo", cor: "#206ce8" };

/** Só a contagem de sessões da vaga do plano passa pelo banco aqui. */
let emUso = 0;
let consultasDeVaga = 0;
const admin = {
  from: () => {
    consultasDeVaga++;
    const q = {
      select: () => q,
      eq: () => q,
      is: () => q,
      neq: () => Promise.resolve({ count: emUso, error: null }),
    };
    return q;
  },
} as never;

const sessaoDaInstalacao = {
  id: "sessao-1",
  accountId: CONTA,
  phoneNumber: "+5511987650000",
  displayName: "Loja",
  status: "WORKING",
  webhookPathToken: "token-que-ja-entrega",
  hasApiKey: false,
  archivedAt: null,
  pelaInstalacao: true,
  profileId: PERFIL,
  webhookId: "w-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  emUso = 0;
  consultasDeVaga = 0;
  h.chave.mockResolvedValue("chave-da-instalacao");
  h.find.mockResolvedValue(null);
  h.save.mockResolvedValue({ error: null, id: "sessao-nova" });
  h.segredoAtual.mockResolvedValue(null);
  h.registrar.mockResolvedValue("w-novo");
  h.garantirPerfil.mockResolvedValue(PERFIL);
  h.whatsappDoPerfil.mockResolvedValue(null);
  h.urlDaPagina.mockResolvedValue("https://provedor.test/cadastro");
  h.contaNoPerfil.mockResolvedValue({
    accountId: CONTA,
    telefone: "+5511987650000",
    nome: "Loja da Ana",
  });
  h.limite.mockResolvedValue(null);
  h.marca.mockResolvedValue({ nome: "Marca Exemplo", origens: { nome: "banco", cor: "banco" } });
});

async function recusa(p: Promise<unknown>): Promise<ErroDaConexaoUmClique> {
  const erro = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro).toBeInstanceOf(ErroDaConexaoUmClique);
  return erro as ErroDaConexaoUmClique;
}

describe("iniciar", () => {
  it("sem chave da instalação não há um clique", async () => {
    h.chave.mockResolvedValue(null);
    expect((await recusa(iniciarConexaoUmClique(admin, ctx, opcoes))).status).toBe(404);
    expect(h.garantirPerfil).not.toHaveBeenCalled();
  });

  it("conexão por chave própria ativa não é sobrescrita", async () => {
    h.find.mockResolvedValue({ ...sessaoDaInstalacao, pelaInstalacao: false, hasApiKey: true });
    expect((await recusa(iniciarConexaoUmClique(admin, ctx, opcoes))).code).toBe("state_conflict");
    expect(h.garantirPerfil).not.toHaveBeenCalled();
  });

  it("plano sem vaga recusa ANTES de qualquer chamada ao provedor", async () => {
    h.limite.mockResolvedValue(1);
    emUso = 1;
    const erro = await recusa(iniciarConexaoUmClique(admin, ctx, opcoes));
    expect(erro.code).toBe("plan_limit_reached");
    expect(erro.message).toMatch(/1 número/);
    expect(h.garantirPerfil).not.toHaveBeenCalled();
    expect(h.urlDaPagina).not.toHaveBeenCalled();
  });

  it("reconectar não consome vaga e reaproveita o perfil gravado", async () => {
    h.limite.mockResolvedValue(1);
    emUso = 1;
    h.find.mockResolvedValue(sessaoDaInstalacao);
    await iniciarConexaoUmClique(admin, ctx, opcoes);
    expect(consultasDeVaga).toBe(0);
    expect(h.garantirPerfil).toHaveBeenCalledWith("chave-da-instalacao", {
      id: ORG,
      nome: "Loja da Ana",
      marca: "Marca Exemplo",
      perfilGravado: PERFIL,
    });
    // A marca da INSTALAÇÃO, nunca a da organização: é ela que separa este
    // sistema de outros que usam a mesma conta do provedor.
    expect(h.marca).toHaveBeenCalledWith(null);
  });

  it("sem marca própria (a do produto), o perfil fica sem prefixo", async () => {
    h.marca.mockResolvedValue({ nome: "Produto", origens: { nome: "padrao", cor: "padrao" } });
    await iniciarConexaoUmClique(admin, ctx, opcoes);
    expect(h.garantirPerfil.mock.calls[0]?.[1]).toMatchObject({ marca: null });
  });

  it("perfil sem número: devolve a página, com a volta assinada para ESTA organização e ESTE perfil", async () => {
    const inicio = await iniciarConexaoUmClique(admin, ctx, opcoes);
    expect(inicio).toEqual({ tipo: "pagina", url: "https://provedor.test/cadastro" });
    const pedido = h.urlDaPagina.mock.calls[0]?.[1] as {
      redirectUrl: string;
      coexistencia: boolean;
      idioma: string;
    };
    expect(pedido.coexistencia).toBe(true);
    expect(pedido.idioma).toBe("es");
    const prefixo = "https://crm.exemplo.com/auth/partner-return/";
    expect(pedido.redirectUrl.startsWith(prefixo)).toBe(true);
    const estado = verificarEstadoDaVolta(pedido.redirectUrl.slice(prefixo.length), {
      segredo: SEGREDO,
      agora: AGORA,
    });
    expect(estado).toMatchObject({ organizationId: ORG, profileId: PERFIL });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("perfil que já tem o número conclui sem passar pela Meta", async () => {
    h.whatsappDoPerfil.mockResolvedValue({
      accountId: CONTA,
      telefone: "+5511987650000",
      nome: "Loja da Ana",
    });
    const inicio = await iniciarConexaoUmClique(admin, ctx, opcoes);
    expect(inicio).toMatchObject({
      tipo: "concluida",
      channelSessionId: "sessao-nova",
      webhookRegistrado: true,
    });
    expect(h.urlDaPagina).not.toHaveBeenCalled();
    expect(h.save.mock.calls[0]?.[1]).toMatchObject({
      organizationId: ORG,
      existingId: null,
      accountId: CONTA,
      credencial: { tipo: "instalacao", profileId: PERFIL },
      phoneNumber: "+5511987650000",
      displayName: "Loja da Ana",
    });
  });
});

describe("concluir", () => {
  const estadoValido = () =>
    emitirEstadoDaVolta(
      { organizationId: ORG, userId: ctx.userId, profileId: PERFIL },
      { segredo: SEGREDO, agora: AGORA },
    );

  it.each([
    [
      "de outra organização",
      () =>
        emitirEstadoDaVolta(
          {
            organizationId: "33333333-3333-4333-8333-333333333333",
            userId: ctx.userId,
            profileId: PERFIL,
          },
          { segredo: SEGREDO, agora: AGORA },
        ),
    ],
    [
      "vencido",
      () =>
        emitirEstadoDaVolta(
          { organizationId: ORG, userId: ctx.userId, profileId: PERFIL },
          { segredo: SEGREDO, agora: new Date(AGORA.getTime() - 31 * 60 * 1000) },
        ),
    ],
    ["forjado", () => "x".repeat(30) + "." + "0".repeat(64)],
  ])("estado %s não conclui nada", async (_nome, gerar) => {
    const erro = await recusa(
      concluirConexaoUmClique(admin, ctx, { estado: gerar(), accountId: CONTA, profileId: PERFIL }),
    );
    expect(erro.status).toBe(400);
    expect(h.contaNoPerfil).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("perfil da URL diferente do assinado não conclui", async () => {
    const erro = await recusa(
      concluirConexaoUmClique(admin, ctx, {
        estado: estadoValido(),
        accountId: CONTA,
        profileId: "c".repeat(24),
      }),
    );
    expect(erro.status).toBe(400);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("recusa da Meta vira o motivo, sem gravar", async () => {
    const erro = await recusa(
      concluirConexaoUmClique(admin, ctx, { estado: estadoValido(), erro: "payment_required" }),
    );
    expect(erro.message).toMatch(/meio de pagamento/);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("conta que o provedor não confirma no perfil não é gravada", async () => {
    h.contaNoPerfil.mockResolvedValue(null);
    await recusa(
      concluirConexaoUmClique(admin, ctx, {
        estado: estadoValido(),
        accountId: CONTA,
        profileId: PERFIL,
      }),
    );
    expect(h.contaNoPerfil).toHaveBeenCalledWith("chave-da-instalacao", PERFIL, CONTA);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("conexão nova: entra no webhook ÚNICO da instalação, sem assinatura própria", async () => {
    const c = await concluirConexaoUmClique(admin, ctx, {
      estado: estadoValido(),
      accountId: CONTA,
      profileId: PERFIL,
    });
    expect(c).toEqual({
      channelSessionId: "sessao-nova",
      phoneNumber: "+5511987650000",
      displayName: "Loja da Ana",
      webhookRegistrado: true,
    });
    expect(h.registrar.mock.calls[0]?.[1]).toEqual({
      organizationId: ORG,
      sessionId: "sessao-nova",
      apiKey: "chave-da-instalacao",
      publicBase: "https://crm.exemplo.com",
      nome: "Marca Exemplo · um clique",
      legado: null,
    });
  });

  it("reconectar reaproveita token e segredo, e a assinatura que não é a compartilhada sai", async () => {
    h.find.mockResolvedValue(sessaoDaInstalacao);
    h.segredoAtual.mockResolvedValue("segredo-que-ja-assina");
    h.save.mockResolvedValue({ error: null, id: "sessao-1" });
    await concluirConexaoUmClique(admin, ctx, {
      estado: estadoValido(),
      accountId: CONTA,
      profileId: PERFIL,
    });
    expect(h.save.mock.calls[0]?.[1]).toMatchObject({
      existingId: "sessao-1",
      webhookPathToken: "token-que-ja-entrega",
      webhookSecretEncrypted: "cifrado:segredo-que-ja-assina",
      displayName: "Loja",
    });
    expect(h.registrar.mock.calls[0]?.[1]).toMatchObject({ sessionId: "sessao-1", legado: "w-1" });
  });

  it("webhook recusado pelo provedor: conectado, mas a resposta diz que não recebe", async () => {
    h.registrar.mockResolvedValue(null);
    const c = await concluirConexaoUmClique(admin, ctx, {
      estado: estadoValido(),
      accountId: CONTA,
      profileId: PERFIL,
    });
    expect(c.webhookRegistrado).toBe(false);
  });

  it("o limite do plano que o banco recusa sobe cru, para a rota traduzir", async () => {
    h.save.mockResolvedValue({ error: "limite_do_plano:canais:1", id: null });
    await expect(
      concluirConexaoUmClique(admin, ctx, {
        estado: estadoValido(),
        accountId: CONTA,
        profileId: PERFIL,
      }),
    ).rejects.toThrow("limite_do_plano:canais:1");
    expect(h.registrar).not.toHaveBeenCalled();
  });
});
