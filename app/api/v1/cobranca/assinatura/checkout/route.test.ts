import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, filtros, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({
  papel: vi.fn(),
  ligada: true,
  provedor: "stripe" as string | null,
  ad: { lerSituacao: vi.fn(), garantirCliente: vi.fn(), iniciarAssinatura: vi.fn(), lerPagamentoProporcional: vi.fn(), expirarSessao: vi.fn() },
  emailDoAdmin: vi.fn(),
  taxaOk: true,
  audit: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  intencao: vi.fn(),
  banco: undefined as unknown as BancoFalso,
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.papel }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => h.ligada }));
vi.mock("@/lib/cobranca/configuracao", () => ({ provedorDaInstalacao: async () => h.provedor }));
vi.mock("@/lib/cobranca/provedores", () => ({ adaptador: () => h.ad, modoDoProvedor: async () => "teste" }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/logger", () => ({ logger: { error: h.logError, warn: h.logWarn, info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.banco.cliente }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: h.taxaOk }) }));
vi.mock("@/lib/cobranca/emails", () => ({ emailDoAdminDaEmpresa: h.emailDoAdmin }));
vi.mock("@/lib/cobranca/contratacao", () => ({ lerIntencaoDeContratacao: h.intencao }));

import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";

import { POST } from "./route";

const ORG = "ffffffff-0000-4000-8000-000000000001";
const CHAVE = "3f1c2d4e-0000-4000-8000-000000000001";
const EM_TESTE = {
  plano_id: "plano-a", estado: "trial", trial_ate: "2026-10-20T00:00:00.000Z", provedor: null, provedor_cliente_id: null,
  checkout_url: null, checkout_expira_em: null,
};
interface Mundo { linha: Record<string, unknown> | null; reservaOk: boolean }
let m: Mundo;

function responder(c: Cadeia): Resposta {
  if (c.tabela === "organizations") return { data: { legal_name: "Loja Legal Ltda", display_name: "Loja" } };
  if (c.tabela === "cobranca_planos") return { data: { id: "plano-a", nome: "Essencial", preco_cents: 4990, intervalo: "mes" } };
  if (operacao(c) === "select") return { data: m.linha };
  if (filtros(c).some((f) => f[0] === "or")) return m.reservaOk ? { data: { organization_id: ORG } } : { data: null };
  return { data: { organization_id: ORG } };
}

const assinar = (corpo?: Record<string, unknown>) =>
  POST(
    new NextRequest("http://localhost/api/v1/cobranca/assinatura/checkout", {
      method: "POST",
      headers: { "Idempotency-Key": CHAVE, ...(corpo ? { "content-type": "application/json" } : {}) },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    }),
  );
const updates = () => h.banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update").map((c) => argumentos(c, "update")?.[0] as Record<string, unknown>);
const codigo = async (res: Response) => ((await res.json()) as { error: { code: string; details?: unknown } }).error;
const CNPJ = ["11", "222", "333", "0001", "81"].join("");
const lerAssinatura = () => h.banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas");

beforeEach(() => {
  vi.clearAllMocks();
  h.ligada = true;
  h.intencao.mockResolvedValue(null);
  h.provedor = "stripe";
  h.taxaOk = true;
  m = { linha: { ...EM_TESTE }, reservaOk: true };
  h.banco = bancoFalso(responder);
  h.papel.mockResolvedValue({ ok: true, user: { id: "admin-1", email: "admin@loja.com" }, org: { orgId: ORG } });
  h.ad.garantirCliente.mockResolvedValue("cus_novo");
  h.emailDoAdmin.mockResolvedValue("ana@loja.com");
  h.ad.iniciarAssinatura.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_1", expiraEm: new Date("2026-10-11T12:00:00Z"), assinaturaRef: null });
});

describe("checkout da assinatura", () => {
  it("continuação automática revalida intenção e usa recibo estável da mesma pessoa/org", async () => {
    h.intencao.mockResolvedValue({ id: CHAVE, planoId: "plano-a" });
    expect((await assinar({ continuar_cadastro: true, volta: "contratacao" })).status).toBe(200);
    expect(h.intencao).toHaveBeenCalledWith(h.banco.cliente, "admin-1", ORG);
    expect(h.ad.iniciarAssinatura).toHaveBeenCalledWith(expect.objectContaining({ chaveIdempotencia: CHAVE, urlDeVolta: expect.stringMatching(/para=contratacao$/) }));
  });
  it("sem prova de intenção não reserva nem chama gateway automaticamente", async () => {
    expect((await assinar({ continuar_cadastro: true })).status).toBe(409);
    expect(updates()).toEqual([]);
    expect(h.ad.iniciarAssinatura).not.toHaveBeenCalled();
  });
  it("plano diferente do compromisso autenticado recusa antes da reserva e do provedor", async () => {
    h.intencao.mockResolvedValue({ id: CHAVE, planoId: "plano-escolhido" });
    expect((await codigo(await assinar({ continuar_cadastro: true }))).code).toBe("state_conflict");
    expect(updates()).toEqual([]);
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();
    expect(h.ad.iniciarAssinatura).not.toHaveBeenCalled();
  });
  it("a reserva exige o mesmo plano lido; concorrência perdedora não chega ao gateway", async () => {
    h.intencao.mockResolvedValue({ id: CHAVE, planoId: "plano-a" });
    m.reservaOk = false;
    expect((await codigo(await assinar({ continuar_cadastro: true }))).code).toBe("checkout_em_preparo");
    const reserva = lerAssinatura().find((c) => operacao(c) === "update" && filtros(c).some((f) => f[0] === "or"));
    expect(reserva).toBeDefined();
    expect(filtros(reserva!)).toContainEqual(["eq", "plano_id", "plano-a"]);
    expect(h.ad.iniciarAssinatura).not.toHaveBeenCalled();
  });
  it("intenção ilegível é erro recuperável e não executa cobrança", async () => {
    h.intencao.mockRejectedValue(new Error("rede"));
    expect((await assinar({ continuar_cadastro: true })).status).toBe(503);
    expect(updates()).toEqual([]);
  });
  it("chave desligada: 404; empresa isenta: 404; nenhum provedor conectado: 409 com frase para leigo", async () => {
    h.ligada = false;
    expect((await assinar()).status).toBe(404);
    h.ligada = true;
    m.linha = null;
    expect((await assinar()).status).toBe(404);
    m.linha = { ...EM_TESTE };
    h.provedor = null;
    expect((await codigo(await assinar())).code).toBe("provedor_nao_conectado");
    expect(h.ad.iniciarAssinatura).not.toHaveBeenCalled();
  });

  it("⭐ link ainda válido é devolvido de novo, sem chamar o provedor (duplo clique, volta do navegador)", async () => {
    m.linha = { ...EM_TESTE, checkout_url: "https://checkout.stripe.com/c/pay/cs_0", checkout_expira_em: new Date(Date.now() + 3_600_000).toISOString() };
    expect((await (await assinar()).json()).data).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_0" });
    expect(h.ad.iniciarAssinatura).not.toHaveBeenCalled();
  });

  it("⭐ outro clique está gerando o link: 409 checkout_em_preparo, sem provedor", async () => {
    m.linha = { ...EM_TESTE, checkout_expira_em: new Date(Date.now() + 60_000).toISOString() };
    expect((await codigo(await assinar())).code).toBe("checkout_em_preparo");
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();
  });

  it("⭐ caminho feliz: reserva, cliente com o nome legal e o e-mail do admin da empresa, checkout com o teste grátis, e grava o link", async () => {
    const res = await assinar();
    expect((await res.json()).data).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    const [reserva, gravacao] = updates();
    expect(reserva).toMatchObject({ checkout_url: null });
    expect(h.ad.garantirCliente).toHaveBeenCalledWith({ id: ORG, nome: "Loja Legal Ltda", email: "ana@loja.com", documento: null });
    const pedido = h.ad.iniciarAssinatura.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(pedido).toMatchObject({ clienteRef: "cus_novo", orgId: ORG, chaveIdempotencia: CHAVE, trialAte: new Date("2026-10-20T00:00:00.000Z") });
    expect(String(pedido.urlDeVolta)).toMatch(/\/cobranca\/volta\?para=painel$/);
    expect(gravacao).toMatchObject({ provedor: "stripe", modo: "teste", provedor_cliente_id: "cus_novo", checkout_url: "https://checkout.stripe.com/c/pay/cs_1", checkout_expira_em: "2026-10-11T12:00:00.000Z" });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.checkout_iniciado", organizationId: ORG, metadata: { provedor: "stripe", modo: "teste", plano_id: "plano-a" } }));
  });

  it("já há assinatura esperando o 1º pagamento: 409 com o link, e a reserva é liberada", async () => {
    m.linha = { ...EM_TESTE, provedor: "stripe", provedor_cliente_id: "cus_1" };
    h.ad.lerSituacao.mockResolvedValue({ assinaturasVivas: 1, linkDePagamento: "https://invoice.stripe.com/i/x" });
    const res = await assinar();
    expect(await codigo(res)).toMatchObject({ code: "pagamento_em_andamento", details: { link_de_pagamento: "https://invoice.stripe.com/i/x" } });
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });
    expect(h.ad.iniciarAssinatura).not.toHaveBeenCalled();
  });

  it("⭐ em atraso com assinatura viva e SEM fatura pagável (pausada): 409 sem_link_de_pagamento que aponta o portal, nunca uma frase que promete link", async () => {
    m.linha = { ...EM_TESTE, estado: "em_atraso", provedor: "stripe", provedor_cliente_id: "cus_1" };
    h.ad.lerSituacao.mockResolvedValue({ assinaturasVivas: 1, linkDePagamento: null });
    const res = await assinar();
    const e = await codigo(res);
    expect(e.code).toBe("sem_link_de_pagamento");
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });
  });

  it("⭐ vindo do hub da conta suspensa: o provedor devolve para /account-suspended (o /app redirecionaria e perderia o ?voltou=1)", async () => {
    await assinar({ volta: "hub" });
    const pedido = h.ad.iniciarAssinatura.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(String(pedido.urlDeVolta)).toMatch(/\/cobranca\/volta\?para=hub$/);
    expect((await assinar({ volta: "https://golpe.example.com" })).status).toBe(400);
  });

  it("mais de 10 chamadas ao provedor por minuto da mesma empresa: 429, sem reservar (a chave é UMA para a instalação)", async () => {
    h.taxaOk = false;
    const res = await assinar();
    expect(res.status).toBe(429);
    expect(updates()).toEqual([]);
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();
  });

  it("provedor fora do ar: 503 e a reserva é liberada", async () => {
    h.ad.iniciarAssinatura.mockRejectedValue(new ErroDoProvedor(503, "api_error", true));
    expect((await codigo(await assinar())).code).toBe("provedor_indisponivel");
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });
  });

  it("provedor recusou: 502", async () => {
    h.ad.garantirCliente.mockRejectedValue(new ErroDoProvedor(400, "parameter_invalid", false));
    expect((await assinar()).status).toBe(502);
  });

  it("correlaciona a recusa com HTTP e código sem despejar corpo ou segredo", async () => {
    const erro = new ErroDoProvedor(400, "invalid_callback", false);
    Object.assign(erro, { response: { description: "segredo-fixture", url: "https://fixture.invalid/?token=segredo-fixture" } });
    h.ad.iniciarAssinatura.mockRejectedValue(erro);
    const res = await assinar();
    expect(res.status).toBe(502);
    expect(h.logWarn).toHaveBeenCalledWith("cobranca: checkout recusado pelo provedor", {
      requestId: expect.any(String), organizationId: ORG, provedor: "stripe",
      status: 400, codigo: "invalid_callback", transitorio: false,
    });
    expect(JSON.stringify(h.logWarn.mock.calls)).not.toContain("segredo-fixture");
    expect(JSON.stringify(await res.json())).not.toContain("invalid_callback");
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });
  });

  it.each(["https://fixture.invalid/?token=segredo-fixture", "$aact_hmlg_fixture", "99991111140", "fixture@example.invalid"])(
    "não registra código do provedor com formato de dado sensível: %s", async (codigoInseguro) => {
      h.ad.iniciarAssinatura.mockRejectedValue(new ErroDoProvedor(400, codigoInseguro, false));
      expect((await assinar()).status).toBe(502);
      expect(h.logWarn).toHaveBeenCalledWith("cobranca: checkout recusado pelo provedor", expect.objectContaining({ codigo: "codigo_nao_publicavel" }));
      expect(JSON.stringify(h.logWarn.mock.calls)).not.toContain(codigoInseguro);
    },
  );

  it("reserva perdida para outro clique entre a leitura e a escrita: 409 checkout_em_preparo", async () => {
    m.reservaOk = false;
    expect((await codigo(await assinar())).code).toBe("checkout_em_preparo");
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();
  });

  it("⭐ a liberação e a gravação do link só tocam a reserva DESTA requisição (uma lenta não pisa na reserva da outra)", async () => {
    h.ad.iniciarAssinatura.mockRejectedValue(new ErroDoProvedor(503, "api_error", true));
    await assinar();
    const escritas = h.banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update");
    const reserva = argumentos(escritas[0]!, "update")?.[0] as { checkout_expira_em: string };
    const liberacao = escritas.at(-1)!;
    expect(filtros(liberacao)).toContainEqual(["eq", "checkout_expira_em", reserva.checkout_expira_em]);
  });

  it("⭐ a gravação do link da fase 3 também filtra pela reserva desta requisição", async () => {
    await assinar();
    const escritas = h.banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update");
    const reserva = argumentos(escritas[0]!, "update")?.[0] as { checkout_expira_em: string };
    expect(filtros(escritas[1]!)).toContainEqual(["eq", "checkout_expira_em", reserva.checkout_expira_em]);
  });

  it("⭐ a gravação do link confere também o plano que o gerou", async () => {
    await assinar();
    const escritas = h.banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update");
    expect(filtros(escritas[1]!)).toContainEqual(["eq", "plano_id", EM_TESTE.plano_id]);
  });

  it("⭐ erro que não é do provedor (banco na fase 3): 500 no envelope com X-Request-Id, logado sem segredo, reserva liberada", async () => {
    let escritas = 0;
    const base = responder;
    h.banco = bancoFalso((c) => {
      if (c.tabela === "cobranca_assinaturas" && operacao(c) === "update" && ++escritas === 2) return { data: null, error: { code: "08006", message: "db caiu sk_test_segredo" } };
      return base(c);
    });
    const res = await assinar();
    expect(res.status).toBe(500);
    expect((await codigo(res)).code).toBe("internal_error");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.logError.mock.calls)).not.toContain("sk_test_segredo");
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });
  });
});

describe("checkout da assinatura pelo Asaas (PR 3b)", () => {
  it("⭐ Asaas sem cliente e sem documento: 422 documento_obrigatorio, sem reservar nem chamar o provedor", async () => {
    h.provedor = "asaas";
    const res = await assinar();
    expect(res.status).toBe(422);
    expect((await codigo(res)).code).toBe("documento_obrigatorio");
    expect(updates()).toEqual([]);
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();
  });

  it("documento com dígito errado: 422 documento_invalido antes de ler a assinatura", async () => {
    h.provedor = "asaas";
    const res = await assinar({ documento: CNPJ.slice(0, 13) + "2" });
    expect(res.status).toBe(422);
    expect((await codigo(res)).code).toBe("documento_invalido");
    expect(lerAssinatura()).toEqual([]);
  });

  it("⭐ Asaas com documento válido (com máscara): só garantirCliente o recebe, já normalizado — nada gravado, auditado ou logado com ele", async () => {
    h.provedor = "asaas";
    h.ad.garantirCliente.mockResolvedValue("cus_asaas_1");
    const res = await assinar({ documento: "11.222.333/0001-81" });
    expect(res.status).toBe(200);
    expect(h.ad.garantirCliente).toHaveBeenCalledWith({ id: ORG, nome: "Loja Legal Ltda", email: "ana@loja.com", documento: CNPJ });
    expect(JSON.stringify(updates())).not.toContain(CNPJ);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(CNPJ);
    expect(JSON.stringify(h.logError.mock.calls)).not.toContain(CNPJ);
  });

  it("Asaas com o cliente já criado (reassinar depois de cancelar): não pede o documento de novo", async () => {
    h.provedor = "asaas";
    m.linha = { ...EM_TESTE, estado: "cancelada", provedor: "asaas", provedor_cliente_id: "cus_asaas_1" };
    h.ad.lerSituacao.mockResolvedValue({ assinaturasVivas: 0, linkDePagamento: null });
    expect((await assinar()).status).toBe(200);
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();
  });

  it("⭐ Asaas: o cliente é gravado ANTES de criar a assinatura (o SUBSCRIPTION_CREATED chega durante o POST e precisa achar a empresa)", async () => {
    h.provedor = "asaas";
    h.ad.garantirCliente.mockResolvedValue("cus_asaas_1");
    let escritasAntesDoInicio = -1;
    h.ad.iniciarAssinatura.mockImplementation(async () => {
      escritasAntesDoInicio = updates().length;
      return { url: "https://sandbox.asaas.com/i/pay_1", expiraEm: null, assinaturaRef: "sub_asaas_1" };
    });
    expect((await assinar({ documento: CNPJ })).status).toBe(200);
    expect(escritasAntesDoInicio).toBe(2);
    expect(updates()[1]).toEqual({ provedor: "asaas", modo: "teste", provedor_cliente_id: "cus_asaas_1", updated_at: expect.any(String) });
    const cliente = h.banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update")[1]!;
    expect(filtros(cliente)).toEqual(expect.arrayContaining([["is", "checkout_url", null]]));
    expect(filtros(cliente).some((f) => f[0] === "eq" && f[1] === "checkout_expira_em")).toBe(true);
  });

  it("⭐ Asaas: a fase 3 grava a assinatura que o provedor já criou (sem ela, a troca no teste grátis não chegaria ao Asaas)", async () => {
    h.provedor = "asaas";
    h.ad.garantirCliente.mockResolvedValue("cus_asaas_1");
    h.ad.iniciarAssinatura.mockResolvedValue({ url: "https://sandbox.asaas.com/i/pay_1", expiraEm: null, assinaturaRef: "sub_asaas_1" });
    expect((await assinar({ documento: CNPJ })).status).toBe(200);
    expect(updates().at(-1)).toMatchObject({ provedor: "asaas", provedor_cliente_id: "cus_asaas_1", provedor_assinatura_id: "sub_asaas_1", checkout_url: "https://sandbox.asaas.com/i/pay_1" });
  });

  it("controle: na Stripe nada muda — duas escritas (reserva e fase 3) e nenhuma assinatura gravada no Assinar", async () => {
    await assinar();
    expect(updates()).toHaveLength(2);
    expect(updates()[1]).not.toHaveProperty("provedor_assinatura_id");
  });

  it("⭐ o Asaas recusou um documento de dígitos certos: 422 documento_recusado, não o 502 'fale com quem administra'", async () => {
    h.provedor = "asaas";
    h.ad.garantirCliente.mockRejectedValue(new ErroDoProvedor(400, "invalid_cpfCnpj", false));
    const res = await assinar({ documento: CNPJ });
    expect(res.status).toBe(422);
    expect((await codigo(res)).code).toBe("documento_recusado");
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });
  });
});

describe("#2961: entrada paga e ajuste proporcional x o checkout cheio (as duas portas passam por gerarLinkDePagamento)", () => {
  const AJUSTE = {
    troca_id: "troca-1", plano_troca_pendente_id: "plano-b", troca_status: "aguardando_pagamento",
    troca_pagamento_ref: "pay_ajuste", troca_pagamento_url: "https://sandbox.asaas.com/i/pay_ajuste",
    troca_reserva_ate: new Date(Date.now() + 10 * 86_400_000).toISOString(),
  };

  it("⭐ ajuste aguardando com a assinatura VIVA: 409 pagamento_em_andamento, nenhum checkout cheio", async () => {
    m.linha = { ...EM_TESTE, ...AJUSTE, estado: "ativa", trial_ate: null, provedor: "asaas", provedor_cliente_id: "cus_1" };
    h.ad.lerSituacao.mockResolvedValue({ assinaturasVivas: 1, linkDePagamento: null });
    expect((await codigo(await assinar())).code).toBe("sem_link_de_pagamento");
    h.ad.lerSituacao.mockResolvedValue({ assinaturasVivas: 1, linkDePagamento: "https://sandbox.asaas.com/i/pay_mensal" });
    expect((await codigo(await assinar())).code).toBe("pagamento_em_andamento");
    expect(h.ad.iniciarAssinatura).not.toHaveBeenCalled();
  });

  it("⭐ entrada pendente (teste de 0 dia, sem cliente): o checkout É a entrada, e o 2º clique devolve o MESMO link", async () => {
    const criada = new Date(Date.now() - 60_000).toISOString();
    m.linha = { ...EM_TESTE, trial_ate: criada, pagamento_inicial_pendente: true };
    expect((await (await assinar()).json()).data).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(h.ad.iniciarAssinatura).toHaveBeenCalledTimes(1);
    m.linha = { ...m.linha, provedor: "stripe", provedor_cliente_id: "cus_novo", checkout_url: "https://checkout.stripe.com/c/pay/cs_1", checkout_expira_em: new Date(Date.now() + 3_600_000).toISOString() };
    expect((await (await assinar()).json()).data).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(h.ad.iniciarAssinatura).toHaveBeenCalledTimes(1);
  });

  it("⭐ ajuste aguardando com a assinatura MORTA (Asaas cancela na hora): o ajuste morre no provedor ANTES do checkout cheio", async () => {
    m.linha = { ...EM_TESTE, ...AJUSTE, estado: "cancelada", trial_ate: null, provedor: "asaas", provedor_cliente_id: "cus_1" };
    h.ad.lerSituacao.mockResolvedValue({ assinaturasVivas: 0, linkDePagamento: null });
    h.ad.lerPagamentoProporcional.mockResolvedValue("pendente");
    h.ad.iniciarAssinatura.mockResolvedValue({ url: "https://sandbox.asaas.com/i/pay_cheio", expiraEm: null, assinaturaRef: "sub_nova" });
    expect((await assinar()).status).toBe(200);
    expect(h.ad.expirarSessao).toHaveBeenCalledWith("pay_ajuste");
    const desistencia = h.banco.cadeias.find((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update" && (argumentos(c, "update")?.[0] as Record<string, unknown>).troca_id === null)!;
    expect(filtros(desistencia)).toContainEqual(["eq", "troca_id", "troca-1"]);
    expect(h.ad.expirarSessao.mock.invocationCallOrder[0]!).toBeLessThan(h.ad.iniciarAssinatura.mock.invocationCallOrder[0]!);
  });

  it("⭐ ajuste já PAGO com a assinatura morta: 409 troca_pendente, nenhum checkout cheio, reserva liberada", async () => {
    m.linha = { ...EM_TESTE, ...AJUSTE, estado: "cancelada", trial_ate: null, provedor: "asaas", provedor_cliente_id: "cus_1" };
    h.ad.lerSituacao.mockResolvedValue({ assinaturasVivas: 0, linkDePagamento: null });
    h.ad.lerPagamentoProporcional.mockResolvedValue("pago");
    expect((await codigo(await assinar())).code).toBe("troca_pendente");
    expect(h.ad.iniciarAssinatura).not.toHaveBeenCalled();
    expect(updates().at(-1)).toEqual({ checkout_expira_em: null });
  });

  it("⭐ quem clica é o dono/provisório (empresa sem cliente no provedor): o cliente nasce com o e-mail do admin da empresa", async () => {
    h.papel.mockResolvedValue({ ok: true, user: { id: "dono-1", email: "dono@instalacao.com" }, org: { orgId: ORG } });
    m.linha = { ...EM_TESTE, trial_ate: new Date(Date.now() - 60_000).toISOString(), pagamento_inicial_pendente: true };
    await assinar();
    expect(h.ad.garantirCliente).toHaveBeenCalledWith(expect.objectContaining({ email: "ana@loja.com" }));
  });

  it("empresa só com o dono provisório (nenhum admin de verdade): 409 empresa_sem_email; admins ilegíveis: 500 sem o endereço no log", async () => {
    h.emailDoAdmin.mockResolvedValue(null);
    expect((await codigo(await assinar())).code).toBe("empresa_sem_email");
    h.emailDoAdmin.mockRejectedValue(new Error("admins ilegíveis (08006)"));
    const res = await assinar();
    expect(res.status).toBe(500);
    expect(h.ad.garantirCliente).not.toHaveBeenCalled();
  });
});
