import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RequirePlatformAdmin from "@/lib/auth/requirePlatformAdmin";

import { argumentos, bancoFalso, operacao, valorDoFiltro, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  escrita: vi.fn(),
  ligada: true,
  url: "https://crm.exemplo.com/api/v1/webhooks/cobranca/stripe" as string | null,
  provedorAtual: null as string | null,
  cifraOk: true,
  chaveUsada: undefined as undefined | (() => Promise<string | null>),
  chaveAntiga: null as string | null,
  segredoAntigo: null as string | null,
  voltar: vi.fn(),
  modoAnterior: null as string | null,
  ad: { testarChave: vi.fn(), prepararWebhook: vi.fn(), clienteExiste: vi.fn(), removerWebhooks: vi.fn() },
  confirmar: vi.fn(),
  desfazer: vi.fn(),
  gravar: vi.fn(),
  regua: vi.fn(),
  donos: vi.fn(),
  audit: vi.fn(),
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof RequirePlatformAdmin>()),
  requirePlatformAdminEscrita: h.escrita,
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => h.ligada }));
vi.mock("@/lib/cobranca/url", () => ({ urlDoWebhookDaCobranca: () => h.url }));
vi.mock("@/lib/cobranca/provedores/base-de-teste", () => ({ baseDeTesteDaCobranca: () => null }));
vi.mock("@/lib/cobranca/configuracao", () => ({
  provedorDaInstalacao: async () => h.provedorAtual,
  chaveDoProvedor: async () => h.chaveAntiga,
  segredoDoWebhook: async () => h.segredoAntigo,
}));
vi.mock("@/lib/cobranca/provedores", () => ({
  adaptador: (_id: string, opcoes?: { chave?: () => Promise<string | null> }) => {
    h.chaveUsada ??= opcoes?.chave;
    return h.ad;
  },
  modoDoProvedor: async () => h.modoAnterior,
}));
vi.mock("@/lib/instalacao/config", () => ({
  gravarPelaTela: h.gravar,
  voltarAoAmbiente: h.voltar,
  estadoParaTela: async () => ({ last4: "9999" }),
}));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: () => {
    if (!h.cifraOk) throw new Error("AI_CRED_AES_KEY ausente");
    return {};
  },
}));
vi.mock("@/lib/cobranca/sincronizar", () => ({ aplicarRegua: h.regua }));
vi.mock("@/lib/cobranca/emails", () => ({ avisarTrocaDeChave: h.donos }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));

import { POST } from "./route";

const CHAVE = ["sk", "test", "51HconexaoDeTeste0001"].join("_");
const CHAVE_ASAAS = "$" + ["aact", "hmlg", "000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6Oj0001"].join("_");
const TOKEN_ASAAS = ["token", "do", "aviso", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"].join("_");
const URL_ASAAS = "https://crm.example.com/api/v1/webhooks/cobranca/asaas";
interface Mundo {
  comProvedor: Array<{ provedor: string; modo: string; provedor_cliente_id?: string }>;
  deTeste: Array<{ organization_id: string; plano_id: string }>;
}
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "cobranca_planos") return { data: [{ id: "plano-a", trial_dias: 14 }] };
  const op = operacao(c);
  if (op === "update") return { data: { organization_id: valorDoFiltro(c, "eq", "organization_id") } };
  if (valorDoFiltro(c, "eq", "modo") === "teste") return { data: m.deTeste };
  return { data: m.comProvedor };
}

const conectar = (corpo: Record<string, unknown> = { provedor: "stripe", chave: CHAVE }) =>
  POST(new NextRequest("http://localhost/api/v1/admin/cobranca/conexao", { method: "POST", body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }));
const erro = async (res: Response) => ((await res.json()) as { error: { code: string; details?: unknown } }).error;

beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = true;
  h.url = "https://crm.exemplo.com/api/v1/webhooks/cobranca/stripe";
  h.provedorAtual = null;
  h.cifraOk = true;
  h.chaveUsada = undefined;
  h.chaveAntiga = null;
  h.segredoAntigo = null;
  h.modoAnterior = null;
  m = { comProvedor: [], deTeste: [] };
  h.banco = bancoFalso(responder);
  h.escrita.mockResolvedValue({ user: { id: "dono", email: "dono@exemplo.com" }, platformAdmin: { scope: "full" } });
  h.ad.testarChave.mockResolvedValue({ ok: true, modo: "teste" });
  h.ad.prepararWebhook.mockResolvedValue({ segredo: "whsec_novo", confirmar: h.confirmar, desfazer: h.desfazer });
  h.ad.clienteExiste.mockResolvedValue(true);
  h.ad.removerWebhooks.mockResolvedValue(1);
  h.voltar.mockResolvedValue({ ok: true });
  h.regua.mockReset();
  h.confirmar.mockResolvedValue(undefined);
  h.desfazer.mockResolvedValue(undefined);
  h.gravar.mockResolvedValue({ ok: true });
});

describe("conexão da cobrança", () => {
  it("chave desligada: 404 e nada chamado", async () => {
    h.ligada = false;
    expect((await conectar()).status).toBe(404);
    expect(h.ad.testarChave).not.toHaveBeenCalled();
  });

  it("⭐ conecta em teste: testa a chave DIGITADA, registra o aviso, grava cifrado e avisa os donos sem a chave", async () => {
    const res = await conectar();
    expect((await res.json()).data).toEqual({ modo: "teste", webhook: "automatico", publicadas: 0 });
    expect(await h.chaveUsada?.()).toBe(CHAVE);
    expect(h.ad.prepararWebhook).toHaveBeenCalledWith("https://crm.exemplo.com/api/v1/webhooks/cobranca/stripe", "dono@exemplo.com");
    expect(h.gravar.mock.calls.map((c) => [c[0], c[2].ehSegredo])).toEqual([
      ["STRIPE_SECRET_KEY", true],
      ["STRIPE_WEBHOOK_SECRET", true],
      ["COBRANCA_PROVEDOR", false],
    ]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.provedor_conectado", metadata: { provedor: "stripe", modo: "teste", last4_antigo: "9999", last4_novo: "0001", webhook: "automatico" },
    }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(CHAVE);
    expect(h.donos).toHaveBeenCalledWith(expect.anything(), { antigo: "9999", novo: "0001" });
    // Os endpoints antigos só saem DEPOIS de o segredo novo estar gravado.
    expect(h.confirmar).toHaveBeenCalledOnce();
    expect(Math.max(...h.gravar.mock.invocationCallOrder)).toBeLessThan(h.confirmar.mock.invocationCallOrder[0]!);
  });

  it("⭐ chave de produção de OUTRA conta com empresas pagando: 409, nada gravado, webhook intocado e a tentativa auditada", async () => {
    h.ad.testarChave.mockResolvedValue({ ok: true, modo: "producao" });
    h.ad.clienteExiste.mockResolvedValue(false);
    m.comProvedor = [{ provedor: "stripe", modo: "producao", provedor_cliente_id: "cus_da_conta_atual" }];
    const res = await conectar();
    expect(res.status).toBe(409);
    expect(await erro(res)).toMatchObject({ code: "chave_de_outra_conta", details: { assinaturas: 1 } });
    expect(h.ad.clienteExiste).toHaveBeenCalledWith("cus_da_conta_atual");
    expect(h.ad.prepararWebhook).not.toHaveBeenCalled();
    expect(h.gravar).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.provedor_conectado", metadata: { provedor: "stripe", modo: "producao", resultado: "recusada_outra_conta", last4_novo: "0001" },
    }));
  });

  it("a mesma conta (rotação da chave com empresas pagando) passa", async () => {
    h.ad.testarChave.mockResolvedValue({ ok: true, modo: "producao" });
    m.comProvedor = [{ provedor: "stripe", modo: "producao", provedor_cliente_id: "cus_da_conta_atual" }];
    expect((await conectar()).status).toBe(200);
    expect(h.gravar).toHaveBeenCalledTimes(3);
  });

  it("⭐ gravação falha no meio: o endpoint NOVO é desfeito e o antigo NÃO é apagado (os avisos seguem chegando)", async () => {
    h.gravar.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, motivo: "banco" });
    expect((await conectar()).status).toBe(500);
    expect(h.desfazer).toHaveBeenCalledOnce();
    expect(h.confirmar).not.toHaveBeenCalled();
    // A chave nova (1ª gravação) não fica no banco: sem anterior, volta ao ambiente; nada auditado nem avisado, nada mudou.
    expect(h.voltar).toHaveBeenCalledWith("STRIPE_SECRET_KEY");
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.donos).not.toHaveBeenCalled();
  });

  it("⭐ gravação falha no meio: a chave nova NÃO fica com o segredo velho (volta ao valor anterior; sem anterior, ao ambiente)", async () => {
    h.chaveAntiga = ["sk", "test", "51HchaveAnterior0001"].join("_");
    h.gravar.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, motivo: "banco" }).mockResolvedValue({ ok: true });
    expect((await conectar()).status).toBe(500);
    expect(h.gravar).toHaveBeenLastCalledWith("STRIPE_SECRET_KEY", ["sk", "test", "51HchaveAnterior0001"].join("_"), expect.objectContaining({ ehSegredo: true }));
    h.gravar.mockReset().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, motivo: "banco" });
    h.chaveAntiga = null;
    await conectar();
    expect(h.voltar).toHaveBeenCalledWith("STRIPE_SECRET_KEY");
  });

  it("⭐ gravação parcial cuja restauração também falha: a troca fica auditada como incompleta", async () => {
    h.gravar.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, motivo: "banco" }).mockResolvedValue({ ok: false, motivo: "banco" });
    h.voltar.mockResolvedValue({ ok: false, motivo: "banco" });
    expect((await conectar()).status).toBe(500);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.provedor_conectado",
      metadata: expect.objectContaining({ resultado: "gravacao_incompleta", last4_novo: CHAVE.slice(-4) }),
    }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(CHAVE);
    expect(h.donos).toHaveBeenCalledWith(expect.anything(), { antigo: "9999", novo: "0001" });
  });

  it("⭐ publicar falha depois das gravações: 500, mas a troca de chave já foi auditada e os donos avisados", async () => {
    h.ad.testarChave.mockResolvedValue({ ok: true, modo: "producao" });
    m.comProvedor = [{ provedor: "stripe", modo: "teste" }];
    m.deTeste = [{ organization_id: "org-1", plano_id: "plano-a" }];
    h.regua.mockRejectedValue(new Error("regua caiu"));
    const res = await conectar({ provedor: "stripe", chave: CHAVE, confirmar_publicacao: true });
    expect(res.status).toBe(500);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.provedor_conectado" }));
    expect(h.donos).toHaveBeenCalledOnce();
    // A org-1 foi convertida antes de a régua cair: o 500 também deixa rastro, com quantas mudaram.
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.modo_publicado",
      metadata: { provedor: "stripe", convertidas: 1, resultado: "publicacao_incompleta" },
    }));
  });

  it("⭐ publicação (teste → produção) com gravação que falha no meio: a chave de TESTE volta e o aviso do modo de teste NÃO é apagado", async () => {
    const chaveDeTeste = ["sk", "test", "51HchaveVelhaDeTeste00"].join("_");
    h.ad.testarChave.mockResolvedValue({ ok: true, modo: "producao" });
    h.chaveAntiga = chaveDeTeste;
    h.segredoAntigo = ["whsec", "doTeste"].join("_");
    h.modoAnterior = "teste";
    h.gravar.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, motivo: "banco" }).mockResolvedValue({ ok: true });
    expect((await conectar()).status).toBe(500);
    expect(h.gravar).toHaveBeenLastCalledWith("STRIPE_SECRET_KEY", chaveDeTeste, expect.objectContaining({ ehSegredo: true }));
    expect(h.ad.removerWebhooks).not.toHaveBeenCalled();
    expect(h.confirmar).not.toHaveBeenCalled();
    expect(h.desfazer).toHaveBeenCalledOnce();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("⭐ trocar de provedor com assinatura de produção: 409 e nada gravado nem testado", async () => {
    h.provedorAtual = "asaas";
    m.comProvedor = [{ provedor: "asaas", modo: "producao" }];
    const res = await conectar();
    expect(res.status).toBe(409);
    expect((await erro(res)).code).toBe("provedor_com_assinaturas");
    expect(h.ad.testarChave).not.toHaveBeenCalled();
    expect(h.gravar).not.toHaveBeenCalled();
  });

  it("⭐ chave de teste no lugar da de produção, com empresas pagando: 409 e o webhook não é tocado", async () => {
    m.comProvedor = [{ provedor: "stripe", modo: "producao" }];
    const res = await conectar();
    expect((await erro(res)).code).toBe("provedor_com_assinaturas");
    expect(h.ad.prepararWebhook).not.toHaveBeenCalled();
    expect(h.gravar).not.toHaveBeenCalled();
  });

  it("publicação sem confirmar: 409 com quantas voltam ao teste grátis, e nada muda", async () => {
    h.ad.testarChave.mockResolvedValue({ ok: true, modo: "producao" });
    m.comProvedor = [{ provedor: "stripe", modo: "teste" }, { provedor: "stripe", modo: "teste" }];
    const res = await conectar();
    expect(await erro(res)).toMatchObject({ code: "publicacao_requer_confirmacao", details: { assinaturas_de_teste: 2 } });
    expect(h.ad.prepararWebhook).not.toHaveBeenCalled();
  });

  it("publicação confirmada: quem assinou em teste volta ao teste grátis com os dias do plano (D-7)", async () => {
    h.ad.testarChave.mockResolvedValue({ ok: true, modo: "producao" });
    m.comProvedor = [{ provedor: "stripe", modo: "teste" }, { provedor: "stripe", modo: "teste" }];
    m.deTeste = [{ organization_id: "org-1", plano_id: "plano-a" }, { organization_id: "org-2", plano_id: "plano-a" }];
    const res = await conectar({ provedor: "stripe", chave: CHAVE, confirmar_publicacao: true });
    expect((await res.json()).data).toMatchObject({ modo: "producao", publicadas: 2 });
    const zeradas = h.banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update");
    expect(argumentos(zeradas[0]!, "update")?.[0]).toMatchObject({ estado: "trial", provedor: null, modo: null, provedor_cliente_id: null, ultimo_aviso: null });
    expect(h.regua.mock.calls.map((c) => c[1])).toEqual(["org-1", "org-2"]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.modo_publicado", metadata: { provedor: "stripe", convertidas: 2 } }));
  });

  it("⭐ publicar apaga, com a chave de TESTE velha, o aviso do modo de teste (senão a Stripe o faria falhar por 3 dias)", async () => {
    h.ad.testarChave.mockResolvedValue({ ok: true, modo: "producao" });
    h.chaveAntiga = ["sk", "test", "51HchaveVelhaDeTeste00"].join("_");
    h.modoAnterior = "teste";
    const res = await conectar();
    expect(res.status).toBe(200);
    expect(h.ad.removerWebhooks).toHaveBeenCalledWith("https://crm.exemplo.com/api/v1/webhooks/cobranca/stripe");
  });

  it("chave recusada pelo provedor: 422 com o motivo, nada gravado", async () => {
    h.ad.testarChave.mockResolvedValue({ ok: false, motivo: "sem_permissao" });
    const res = await conectar();
    expect(res.status).toBe(422);
    expect(await erro(res)).toMatchObject({ code: "chave_recusada", details: { motivo: "sem_permissao" } });
    expect(h.gravar).not.toHaveBeenCalled();
  });

  it("sem endereço https público: 422 e o provedor nem é chamado", async () => {
    h.url = null;
    expect((await erro(await conectar())).code).toBe("url_publica_invalida");
    expect(h.ad.testarChave).not.toHaveBeenCalled();
  });

  it("sem a chave de cifra do servidor: 503 antes de qualquer chamada ao provedor", async () => {
    h.cifraOk = false;
    expect((await conectar()).status).toBe(503);
    expect(h.ad.testarChave).not.toHaveBeenCalled();
  });

  it("provedor fora do ar ao registrar o aviso: 503 e nada gravado", async () => {
    const { ErroDoProvedor } = await import("@/lib/cobranca/provedores/contrato");
    h.ad.prepararWebhook.mockRejectedValue(new ErroDoProvedor(503, "api_error", true));
    const res = await conectar();
    expect((await erro(res)).code).toBe("provedor_indisponivel");
    expect(h.gravar).not.toHaveBeenCalled();
  });

  it("adaptador que lança erro fora do contrato (ZodError/TypeError): 502 explicado, nunca 500 cru", async () => {
    h.ad.testarChave.mockRejectedValue(new TypeError("Invalid URL"));
    const res = await conectar();
    expect(res.status).toBe(502);
    expect((await erro(res)).code).toBe("provedor_recusou");
    expect(h.gravar).not.toHaveBeenCalled();
  });
});

describe("conexão da cobrança pelo Asaas (PR 3b)", () => {
  it("⭐ Asaas com aviso criado pela API: as chaves do Asaas, cifradas, e o resto igual à Stripe", async () => {
    const res = await conectar({ provedor: "asaas", chave: CHAVE_ASAAS });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ modo: "teste", webhook: "automatico", publicadas: 0 });
    expect(await h.chaveUsada?.()).toBe(CHAVE_ASAAS);
    expect(h.gravar.mock.calls.map((c) => [c[0], c[2].ehSegredo])).toEqual([
      ["ASAAS_API_KEY", true],
      ["ASAAS_WEBHOOK_TOKEN", true],
      ["COBRANCA_PROVEDOR", false],
    ]);
    expect(h.confirmar).toHaveBeenCalledOnce();
  });

  it("⭐ Asaas sem a API de avisos: grava o token cifrado, devolve URL+token+eventos UMA vez, e o token não vai ao audit", async () => {
    h.ad.prepararWebhook.mockResolvedValue({ manual: { url: URL_ASAAS, segredo: TOKEN_ASAAS, eventos: ["PAYMENT_CONFIRMED", "PAYMENT_OVERDUE"] } });
    const res = await conectar({ provedor: "asaas", chave: CHAVE_ASAAS });
    expect(res.status).toBe(200);
    // O token vai em claro neste corpo: nenhum cache pode guardá-lo.
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await res.json()).data).toEqual({
      modo: "teste",
      webhook: { manual: { url: URL_ASAAS, segredo: TOKEN_ASAAS, eventos: ["PAYMENT_CONFIRMED", "PAYMENT_OVERDUE"] } },
      publicadas: 0,
    });
    expect(h.gravar.mock.calls.map((c) => [c[0], c[1], c[2].ehSegredo])).toEqual([
      ["ASAAS_API_KEY", CHAVE_ASAAS, true],
      ["ASAAS_WEBHOOK_TOKEN", TOKEN_ASAAS, true],
      ["COBRANCA_PROVEDOR", "asaas", false],
    ]);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.provedor_conectado",
      metadata: { provedor: "asaas", modo: "teste", last4_antigo: "9999", last4_novo: CHAVE_ASAAS.slice(-4), webhook: "manual" },
    }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(TOKEN_ASAAS);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(CHAVE_ASAAS);
    expect(h.confirmar).not.toHaveBeenCalled();
    // Os avisos antigos desta URL levariam o token velho (401 em laço): saem, depois de o token novo ser gravado.
    expect(h.ad.removerWebhooks).toHaveBeenCalledWith(h.url);
    expect(h.ad.removerWebhooks.mock.invocationCallOrder[0]).toBeGreaterThan(h.gravar.mock.invocationCallOrder[1] ?? Infinity);
  });

  it("Asaas manual em que nem apagar os avisos antigos a conta deixa: segue 200 com o passo a passo", async () => {
    h.ad.prepararWebhook.mockResolvedValue({ manual: { url: URL_ASAAS, segredo: TOKEN_ASAAS, eventos: ["PAYMENT_CONFIRMED"] } });
    h.ad.removerWebhooks.mockRejectedValue(new Error("a conta não deixa listar avisos"));
    const res = await conectar({ provedor: "asaas", chave: CHAVE_ASAAS });
    expect(res.status).toBe(200);
    expect((await res.json()).data.webhook).toEqual({ manual: { url: URL_ASAAS, segredo: TOKEN_ASAAS, eventos: ["PAYMENT_CONFIRMED"] } });
  });

  it("⭐ chave do Asaas no formato antigo (sem _prod_/_hmlg_): 422 que manda gerar outra, sem testar nem gravar", async () => {
    const antiga = "$" + ["aact", "YTU5YTE0M2M2N2I4MTliNzk0YTI5N2U5MzdjNWZmNDQ"].join("_");
    const res = await conectar({ provedor: "asaas", chave: antiga });
    expect(res.status).toBe(422);
    const e = (await res.json()) as { error: { code: string; message: string; details: { motivo: string } } };
    expect(e.error).toMatchObject({ code: "chave_recusada", details: { motivo: "chave_formato_antigo" } });
    expect(e.error.message).toContain("formato antigo");
    expect(h.ad.testarChave).not.toHaveBeenCalled();
    expect(h.gravar).not.toHaveBeenCalled();
  });

  it("⭐ Asaas manual com gravação que falha: 500 explicado, e nada a desfazer no provedor (não há endpoint nosso lá)", async () => {
    h.ad.prepararWebhook.mockResolvedValue({ manual: { url: URL_ASAAS, segredo: TOKEN_ASAAS, eventos: ["PAYMENT_CONFIRMED"] } });
    h.gravar.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, motivo: "banco_recusou", detalhe: "x" });
    const res = await conectar({ provedor: "asaas", chave: CHAVE_ASAAS });
    expect(res.status).toBe(500);
    expect((await erro(res)).code).toBe("internal_error");
    expect(h.desfazer).not.toHaveBeenCalled();
  });

  it("chave recusada pelo Asaas: a frase fala do Asaas, não da Stripe", async () => {
    h.ad.testarChave.mockResolvedValue({ ok: false, motivo: "chave_invalida" });
    const res = await conectar({ provedor: "asaas", chave: CHAVE_ASAAS });
    expect(res.status).toBe(422);
    const e = (await res.json()) as { error: { code: string; message: string } };
    expect(e.error.code).toBe("chave_recusada");
    expect(e.error.message).toContain("Asaas");
    expect(h.gravar).not.toHaveBeenCalled();
  });
});
