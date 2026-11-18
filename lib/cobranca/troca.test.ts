import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, filtros, operacao, valorDoFiltro, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

vi.mock("@/lib/cobranca/provedores", () => ({
  adaptador: () => {
    throw new Error("use deps.adaptador no teste");
  },
}));

import { ErroDoProvedor, type AdaptadorDeCobranca } from "@/lib/cobranca/provedores/contrato";

import { trocarPlanoDaOrg } from "./troca";

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const AGORA = new Date("2026-10-10T12:00:00Z");
const plano = (id: string, extra: Record<string, unknown> = {}) => ({
  id, nome: id, preco_cents: 4990, moeda: "BRL", intervalo: "mes", max_assentos: 5, max_canais: 2, arquivado_em: null, oferecido_ao_cliente: true, ...extra,
});
const PLANOS = [
  plano("basico"), plano("pro", { preco_cents: 9990 }), plano("mini", { max_assentos: 1 }), plano("anual", { intervalo: "ano" }),
  plano("negociado", { preco_cents: 2990, oferecido_ao_cliente: false }),
  plano("dolar", { preco_cents: 9990, moeda: "USD" }),
];

interface Mundo { linha: Record<string, unknown> | null; assentos: number; canais: number; casPerdido: boolean; falharAoRegistrarPagamento: boolean }
let m: Mundo;
let banco: BancoFalso;
const trocarNoProvedor = vi.fn<AdaptadorDeCobranca["trocarPlano"]>();
const expirarSessao = vi.fn<AdaptadorDeCobranca["expirarSessao"]>();
const iniciarAjusteProporcional = vi.fn<AdaptadorDeCobranca["iniciarAjusteProporcional"]>();
const lerPagamentoProporcional = vi.fn<AdaptadorDeCobranca["lerPagamentoProporcional"]>();

function responder(c: Cadeia): Resposta {
  if (c.tabela === "cobranca_planos") return { data: PLANOS.find((p) => p.id === valorDoFiltro(c, "eq", "id")) ?? null };
  if (c.tabela === "user_organizations") return { count: m.assentos };
  if (c.tabela === "channel_sessions") return { count: m.canais };
  if (m.falharAoRegistrarPagamento && operacao(c) === "update" && argumentos(c, "update")?.[0] &&
      (argumentos(c, "update")?.[0] as Record<string, unknown>).troca_status === "aguardando_pagamento") {
    return { data: null, error: { message: "database unavailable" } };
  }
  if (operacao(c) === "select") return { data: m.linha };
  return m.casPerdido ? { data: null } : { data: { organization_id: ORG } };
}

const trocar = (planoId: string, origem?: "empresa" | "dono") =>
  trocarPlanoDaOrg(banco.cliente as never, ORG, planoId, {
    adaptador: () => ({ trocarPlano: trocarNoProvedor, expirarSessao, iniciarAjusteProporcional, lerPagamentoProporcional } as unknown as AdaptadorDeCobranca),
    agora: () => AGORA,
    origem,
  });
const escritas = () => banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update");
const EM_TESTE = { plano_id: "basico", plano_agendado_id: null, estado: "trial", trial_ate: "2026-10-20T00:00:00Z", provedor: null, provedor_assinatura_id: null, proximo_vencimento: null, checkout_url: null, checkout_expira_em: null, checkout_sessao_id: null };
const PAGANDO = { ...EM_TESTE, estado: "ativa", provedor: "stripe", provedor_cliente_id: "cus_1", provedor_assinatura_id: "sub_1", periodo_pago_desde: "2026-10-01T00:00:00Z", proximo_vencimento: "2026-11-01T00:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  m = { linha: { ...EM_TESTE }, assentos: 1, canais: 1, casPerdido: false, falharAoRegistrarPagamento: false };
  banco = bancoFalso(responder);
  trocarNoProvedor.mockResolvedValue(undefined);
  expirarSessao.mockResolvedValue(undefined);
  iniciarAjusteProporcional.mockResolvedValue({ pagamentoRef: "pay_adjustment_1", url: "https://pay.example/adjustment" });
  lerPagamentoProporcional.mockResolvedValue("pendente");
});

describe("trocarPlanoDaOrg", () => {
  it("teste grátis sem provedor: vale na hora, por compare-and-set no plano lido", async () => {
    expect(await trocar("pro")).toMatchObject({ ok: true, changed: true, quando: "imediato", planoId: "pro" });
    expect(Object.keys(argumentos(escritas()[0]!, "update")?.[0] as object).sort()).toEqual(["plano_agendado_id", "plano_id", "updated_at"]);
    expect(filtros(escritas()[0]!)).toEqual([["eq", "organization_id", ORG], ["eq", "plano_id", "basico"], ["is", "plano_agendado_id", null], ["is", "provedor", null], ["is", "checkout_expira_em", null]]);
    expect(trocarNoProvedor).not.toHaveBeenCalled();
  });

  it("⭐ teste grátis com provedor: o preço da 1ª cobrança muda no provedor e a troca vale na hora (D-13)", async () => {
    m.linha = { ...EM_TESTE, provedor: "stripe", provedor_assinatura_id: "sub_1" };
    expect(await trocar("pro")).toMatchObject({ ok: true, quando: "imediato", planoId: "pro" });
    expect(trocarNoProvedor).toHaveBeenCalledWith({ assinaturaRef: "sub_1", plano: { id: "pro", nome: "pro", precoCents: 9990, moeda: "BRL", intervalo: "mes" } });
  });

  // Se a assinatura está ativa, upgrade usa o fluxo proporcional. Sem dados
  // suficientes do período pago, a operação falha fechada e não agenda plano.
  it("⭐ upgrade com cobrança cheia em aberto e a linha atrasada: recusa, sem ajuste sobre o período antigo", async () => {
    // Linha ainda 'ativa' com o período antigo, mas um Assinar já gravou link vivo e
    // assinatura nova (aviso de remoção da antiga perdido). Sem a guarda, o ajuste
    // seria calculado sobre o período velho e somaria à cobrança cheia.
    m.linha = { ...PAGANDO, provedor: "asaas", provedor_assinatura_id: "sub_nova", checkout_url: "https://pay.example/cheia", checkout_expira_em: "2026-10-11T12:00:00Z" };
    expect(await trocar("pro", "empresa")).toMatchObject({ ok: false, status: 409, code: "pagamento_do_periodo_pendente" });
    expect(iniciarAjusteProporcional).not.toHaveBeenCalled();
    expect(escritas()).toHaveLength(0);
  });

  it("⭐ upgrade com período pago desconhecido: recusa sem alterar plano ou preço", async () => {
    m.linha = { ...PAGANDO, periodo_pago_desde: null };
    expect(await trocar("pro")).toMatchObject({ ok: false, status: 409, code: "periodo_indisponivel" });
    expect(escritas()).toEqual([]);
    expect(trocarNoProvedor).not.toHaveBeenCalled();
  });

  it("voltar ao plano atual desfaz o agendamento (e o preço volta no provedor)", async () => {
    m.linha = { ...PAGANDO, plano_agendado_id: "pro" };
    expect(await trocar("basico")).toMatchObject({ ok: true, quando: "agendado", planoAgendadoId: null });
    expect(argumentos(escritas()[0]!, "update")?.[0]).toMatchObject({ plano_agendado_id: null });
  });

  const COM_AJUSTE = { ...PAGANDO, troca_id: "troca-1", plano_troca_pendente_id: "pro", troca_status: "aguardando_pagamento", troca_pagamento_ref: "pay-1", troca_reserva_ate: "2026-11-01T00:00:00Z" };
  const limpouATroca = () => escritas().some((c) => (argumentos(c, "update")?.[0] as Record<string, unknown>).troca_id === null);

  it("⭐ outro plano com o ajuste em aberto: a cobrança morre NO PROVEDOR antes, a linha a esquece, e o pedido novo segue", async () => {
    m.linha = { ...COM_AJUSTE };
    expect(await trocar("mini")).toMatchObject({ ok: true, quando: "agendado", planoAgendadoId: "mini" });
    expect(expirarSessao).toHaveBeenCalledWith("pay-1");
    expect(expirarSessao.mock.invocationCallOrder[0]!).toBeLessThan(trocarNoProvedor.mock.invocationCallOrder[0]!);
    const limpeza = escritas().find((c) => (argumentos(c, "update")?.[0] as Record<string, unknown>).troca_id === null);
    expect(filtros(limpeza!)).toContainEqual(["eq", "troca_id", "troca-1"]);
  });

  it("⭐ outro plano com o ajuste JÁ PAGO: não há desistência — 409 troca_pendente, nada expirado nem limpo", async () => {
    m.linha = { ...COM_AJUSTE };
    lerPagamentoProporcional.mockResolvedValue("pago");
    expect(await trocar("mini")).toMatchObject({ ok: false, status: 409, code: "troca_pendente" });
    expect(expirarSessao).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
    expect(trocarNoProvedor).not.toHaveBeenCalled();
  });

  it("outro plano e o provedor recusa expirar (boleto já emitido): 409 troca_pendente e a linha não esquece a cobrança", async () => {
    m.linha = { ...COM_AJUSTE };
    expirarSessao.mockRejectedValue(new ErroDoProvedor(400, "sessao_nao_expiravel", false));
    expect(await trocar("mini")).toMatchObject({ ok: false, status: 409, code: "troca_pendente" });
    expect(limpouATroca()).toBe(false);
    expect(trocarNoProvedor).not.toHaveBeenCalled();
  });

  it("pedido recusado (uso acima do plano) não custa o ajuste em aberto", async () => {
    m.linha = { ...COM_AJUSTE };
    m.assentos = 3;
    expect(await trocar("mini")).toMatchObject({ ok: false, code: "plan_limit_reached" });
    expect(expirarSessao).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });

  it("⭐ o DONO pede upgrade depois do teste: agenda (plano negociado não paga diferença) — nenhuma cobrança avulsa", async () => {
    m.linha = { ...PAGANDO };
    expect(await trocar("pro", "dono")).toMatchObject({ ok: true, changed: true, quando: "agendado", planoAgendadoId: "pro" });
    expect(iniciarAjusteProporcional).not.toHaveBeenCalled();
    expect(trocarNoProvedor).toHaveBeenCalledOnce();
  });

  it("o DONO pede o MESMO plano do ajuste em aberto: desiste do ajuste e agenda", async () => {
    m.linha = { ...COM_AJUSTE };
    expect(await trocar("pro", "dono")).toMatchObject({ ok: true, quando: "agendado", planoAgendadoId: "pro" });
    expect(expirarSessao).toHaveBeenCalledWith("pay-1");
    expect(iniciarAjusteProporcional).not.toHaveBeenCalled();
  });

  it("⭐ ajuste abaixo do mínimo do provedor: agenda em vez de mandar ao provedor uma cobrança que ele recusaria", async () => {
    // A 6 h do fim do período, R$ 50,00 de diferença dá ~R$ 0,40.
    m.linha = { ...PAGANDO, proximo_vencimento: "2026-10-10T18:00:00Z", periodo_pago_desde: "2026-09-10T18:00:00Z" };
    expect(await trocar("pro")).toMatchObject({ ok: true, quando: "agendado", planoAgendadoId: "pro" });
    expect(iniciarAjusteProporcional).not.toHaveBeenCalled();
  });

  it("⭐ mesmo upgrade com o ajuste vencido (o período do cálculo acabou): a cobrança velha morre e sai uma nova, com a conta de agora", async () => {
    m.linha = { ...COM_AJUSTE, troca_reserva_ate: "2026-10-01T00:00:00Z" };
    expect(await trocar("pro")).toMatchObject({ ok: true, quando: "pagamento_pendente", urlPagamento: "https://pay.example/adjustment" });
    expect(expirarSessao).toHaveBeenCalledWith("pay-1");
    expect(iniciarAjusteProporcional).toHaveBeenCalledOnce();
  });

  it("solicitação repetida do mesmo upgrade devolve o link pendente sem duplicar cobrança", async () => {
    m.linha = { ...PAGANDO, troca_id: "troca-1", plano_troca_pendente_id: "pro", troca_status: "aguardando_pagamento", troca_pagamento_ref: "pay-1", troca_pagamento_url: "https://pay.example/existing" };
    expect(await trocar("pro")).toMatchObject({ ok: true, changed: false, quando: "pagamento_pendente", urlPagamento: "https://pay.example/existing" });
    expect(lerPagamentoProporcional).toHaveBeenCalledWith("pay-1");
    expect(iniciarAjusteProporcional).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });

  it("persiste a cobrança proporcional antes de devolver o link", async () => {
    m.linha = { ...PAGANDO, provedor_cliente_id: "cus_1", periodo_pago_desde: "2026-10-01T00:00:00Z" };
    expect(await trocar("pro")).toMatchObject({ ok: true, quando: "pagamento_pendente", urlPagamento: "https://pay.example/adjustment" });
    expect(iniciarAjusteProporcional).toHaveBeenCalledOnce();
    const salvar = escritas().find((c) => (argumentos(c, "update")?.[0] as Record<string, unknown>).troca_status === "aguardando_pagamento");
    expect(salvar).toBeDefined();
    expect(filtros(salvar!)).toContainEqual(["eq", "troca_id", expect.any(String)]);
    expect(filtros(salvar!)).toContainEqual(["eq", "troca_status", "criando"]);
    // O prazo da cobrança é o fim do período em que a conta foi feita.
    expect(argumentos(salvar!, "update")?.[0]).toMatchObject({ troca_reserva_ate: "2026-11-01T00:00:00Z" });
    expect(expirarSessao).not.toHaveBeenCalled();
  });

  it("se não registrar o pagamento criado, não devolve link e tenta invalidar a cobrança", async () => {
    m.linha = { ...PAGANDO, provedor_cliente_id: "cus_1", periodo_pago_desde: "2026-10-01T00:00:00Z" };
    m.falharAoRegistrarPagamento = true;
    expect(await trocar("pro")).toMatchObject({ ok: false, status: 500, code: "pagamento_nao_registrado" });
    expect(expirarSessao).toHaveBeenCalledWith("pay_adjustment_1");
  });

  it.each(["em_atraso", "cancelada"])("estado %s: 409 pagamento_pendente, e o provedor nem é chamado", async (estado) => {
    m.linha = { ...PAGANDO, estado };
    expect(await trocar("pro")).toMatchObject({ ok: false, status: 409, code: "pagamento_pendente" });
    expect(trocarNoProvedor).not.toHaveBeenCalled();
  });

  it("uso acima do plano novo: 409 plan_limit_reached com o que remover, antes do provedor", async () => {
    m.assentos = 3;
    expect(await trocar("mini")).toMatchObject({ ok: false, code: "plan_limit_reached", details: { excedente: { assentos: 2 } } });
    expect(trocarNoProvedor).not.toHaveBeenCalled();
  });

  it("⭐ provedor fora do ar: 503 provedor_indisponivel e nada gravado", async () => {
    m.linha = { ...PAGANDO };
    trocarNoProvedor.mockRejectedValue(new ErroDoProvedor(503, "api_error", true));
    expect(await trocar("mini")).toMatchObject({ ok: false, status: 503, code: "provedor_indisponivel" });
    expect(escritas()).toEqual([]);
  });

  it("⭐ o provedor recusa por período corrente pendente (Asaas): 409 com o código da spec, e nada gravado", async () => {
    m.linha = { ...PAGANDO };
    trocarNoProvedor.mockRejectedValue(new ErroDoProvedor(null, "pagamento_do_periodo_pendente", false));
    expect(await trocar("mini")).toMatchObject({
      ok: false, status: 409, code: "pagamento_do_periodo_pendente", message: FRASE_DO_PERIODO_PENDENTE,
    });
    expect(escritas()).toEqual([]);
  });

  it("outro intervalo: 422 plano_invalido", async () => {
    expect(await trocar("anual")).toMatchObject({ ok: false, status: 422, code: "plano_invalido" });
  });

  it("⭐ outra moeda (migration 9332): 422 plano_invalido, nem a empresa nem o dono trocam", async () => {
    expect(await trocar("dolar")).toMatchObject({ ok: false, status: 422, code: "plano_invalido", message: "Escolha um plano na mesma moeda da assinatura atual." });
    expect(await trocar("dolar", "dono")).toMatchObject({ ok: false, status: 422, code: "plano_invalido" });
    expect(escritas()).toEqual([]);
  });

  it("⭐ plano negociado (não oferecido): a EMPRESA não o escolhe; o DONO o atribui", async () => {
    expect(await trocar("negociado")).toMatchObject({ ok: false, status: 422, code: "plano_invalido" });
    expect(await trocar("negociado", "dono")).toMatchObject({ ok: true, quando: "imediato", planoId: "negociado" });
  });
  // O link (ou a reserva dele) gravado entre a leitura e a escrita faz a troca perder:
  // o compare-and-set confere o prazo do link como foi LIDO.
  it("⭐ teste grátis: o compare-and-set confere o link como foi lido", async () => {
    await trocar("pro");
    expect(filtros(escritas()[0]!)).toContainEqual(["is", "checkout_expira_em", null]);
    m.linha = { ...EM_TESTE, provedor: "stripe", checkout_url: "https://checkout.stripe.com/c/pay/cs_x", checkout_expira_em: "2026-10-01T00:00:00Z" };
    await trocar("pro");
    expect(filtros(escritas()[1]!)).toContainEqual(["eq", "checkout_expira_em", "2026-10-01T00:00:00Z"]);
  });

  it("⭐ CAS perdido depois de o provedor aceitar: 409 e o preço volta ao que o banco registra", async () => {
    m.linha = { ...PAGANDO };
    m.casPerdido = true;
    // outra troca venceu a corrida: a releitura mostra pro agendado
    trocarNoProvedor.mockImplementationOnce(async () => { m.linha = { ...PAGANDO, plano_agendado_id: "pro" }; });
    expect(await trocar("mini")).toMatchObject({ ok: false, status: 409, code: "state_conflict" });
    expect(trocarNoProvedor).toHaveBeenCalledTimes(2);
    expect(trocarNoProvedor.mock.calls[1]![0].plano.id).toBe("pro");
    expect(filtros(escritas()[0]!)).toContainEqual(["is", "plano_agendado_id", null]);
  });

  it("CAS perdido e o desfazer também falha: a divergência é dita", async () => {
    m.linha = { ...PAGANDO };
    m.casPerdido = true;
    trocarNoProvedor.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ErroDoProvedor(503, "api_error", true));
    const r = await trocar("mini");
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as { message: string }).message).toContain("pode estar diferente");
  });

  it("provedor transitório: não afirma 'Nada mudou'", async () => {
    m.linha = { ...PAGANDO };
    trocarNoProvedor.mockRejectedValueOnce(new ErroDoProvedor(503, "api_error", true));
    const r = await trocar("mini");
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect((r as { message: string }).message).not.toContain("Nada mudou");
  });

  it.each([
    ["plano atual arquivado", { arquivado_em: "2026-01-01T00:00:00Z" }],
    ["plano atual negociado", { oferecido_ao_cliente: false }],
  ])("⭐ desfazer o agendamento não é recusado por %s", async (_n, extra) => {
    PLANOS.push(plano("atualx", extra));
    try {
      m.linha = { ...PAGANDO, plano_id: "atualx", plano_agendado_id: "pro" };
      expect(await trocar("atualx")).toMatchObject({ ok: true, quando: "agendado", planoAgendadoId: null });
    } finally { PLANOS.pop(); }
  });

  it("⭐ teste grátis com link de pagamento em aberto: a troca é recusada com 409 checkout_em_aberto e nada muda", async () => {
    m.linha = { ...EM_TESTE, provedor: "stripe", checkout_url: "https://pagar.exemplo/s1", checkout_expira_em: "2026-10-10T13:00:00Z" };
    expect(await trocar("pro")).toMatchObject({ ok: false, status: 409, code: "checkout_em_aberto" });
    expect(escritas()).toEqual([]);
    expect(trocarNoProvedor).not.toHaveBeenCalled();
  });

  // #2609: com a id da sessão guardada, o link em aberto NÃO trava mais a troca —
  // a sessão expira NO PROVEDOR (antes da escrita), a troca vale na hora e o link
  // antigo deixa de valer. Sem a id guardada (linha anterior à 0641) não há o que
  // expirar, e vale a recusa do teste acima.
  it("⭐ #2609 link em aberto com a sessão guardada: a troca expira a sessão no provedor, conclui e limpa o link", async () => {
    m.linha = {
      ...EM_TESTE, provedor: "stripe",
      checkout_url: "https://pagar.exemplo/s1", checkout_expira_em: "2026-10-10T13:00:00Z", checkout_sessao_id: "cs_aberta_1",
    };
    expect(await trocar("pro")).toMatchObject({ ok: true, changed: true, quando: "imediato", planoId: "pro" });
    expect(expirarSessao).toHaveBeenCalledOnce();
    expect(expirarSessao).toHaveBeenCalledWith("cs_aberta_1");
    expect(trocarNoProvedor).not.toHaveBeenCalled();
    expect(argumentos(escritas()[0]!, "update")?.[0]).toMatchObject({
      plano_id: "pro", checkout_url: null, checkout_expira_em: null, checkout_sessao_id: null,
    });
  });

  it("#2609 o provedor não confirmou a expiração: 503 e nada muda — o link antigo continua valendo", async () => {
    m.linha = {
      ...EM_TESTE, provedor: "stripe",
      checkout_url: "https://pagar.exemplo/s1", checkout_expira_em: "2026-10-10T13:00:00Z", checkout_sessao_id: "cs_aberta_1",
    };
    expirarSessao.mockRejectedValueOnce(new ErroDoProvedor(503, "api_error", true));
    expect(await trocar("pro")).toMatchObject({ ok: false, status: 503, code: "provedor_indisponivel" });
    expect(escritas()).toEqual([]);
  });

  // A recusa NÃO transitória é a mais cara de perder: a Stripe recusa (400) expirar
  // a sessão que já foi PAGA e cujo aviso ainda não chegou. Seguir com a troca aí
  // gravaria o plano novo para quem acabou de pagar o antigo.
  it("#2609 o provedor recusou expirar (sessão já paga): a mesma recusa de sempre, e nada muda", async () => {
    m.linha = {
      ...EM_TESTE, provedor: "stripe",
      checkout_url: "https://pagar.exemplo/s1", checkout_expira_em: "2026-10-10T13:00:00Z", checkout_sessao_id: "cs_paga_1",
    };
    expirarSessao.mockRejectedValueOnce(new ErroDoProvedor(400, "invalid_request_error", false));
    expect(await trocar("pro")).toMatchObject({ ok: false, status: 409, code: "checkout_em_aberto" });
    expect(escritas()).toEqual([]);
    expect(trocarNoProvedor).not.toHaveBeenCalled();
  });

  it("teste grátis com link de pagamento já expirado: a troca vale na hora e o link sai junto", async () => {
    m.linha = { ...EM_TESTE, provedor: "stripe", checkout_url: "https://pagar.exemplo/s1", checkout_expira_em: "2026-10-10T11:00:00Z" };
    expect(await trocar("pro")).toMatchObject({ ok: true, quando: "imediato", planoId: "pro" });
    expect(argumentos(escritas()[0]!, "update")?.[0]).toMatchObject({ plano_id: "pro", checkout_url: null, checkout_expira_em: null });
  });

  it("desfazer o agendamento com uso acima do plano atual não dá 409 plan_limit_reached", async () => {
    m.linha = { ...PAGANDO, plano_id: "mini", plano_agendado_id: "pro" };
    m.assentos = 3;
    expect(await trocar("mini")).toMatchObject({ ok: true, planoAgendadoId: null });
  });
});

const FRASE_DO_PERIODO_PENDENTE =
  'A mensalidade de agora ainda não foi paga. Pague em "Pagar agora" e troque de plano depois que o pagamento for confirmado (Pix: minutos; boleto: até 1 dia útil).';

describe("troca no teste grátis com a assinatura já criada no provedor (Asaas, PR 3b)", () => {
  const FATURA = "https://sandbox.asaas.com/i/pay_1";

  it("⭐ o provedor leva o preço novo à fatura aberta, e o link dela FICA (o próximo Assinar devolve a mesma fatura)", async () => {
    m.linha = { ...EM_TESTE, provedor: "asaas", provedor_assinatura_id: "sub_asaas_1", checkout_url: FATURA };
    expect(await trocar("pro")).toMatchObject({ ok: true, quando: "imediato", planoId: "pro" });
    expect(trocarNoProvedor).toHaveBeenCalledWith({ assinaturaRef: "sub_asaas_1", plano: { id: "pro", nome: "pro", precoCents: 9990, moeda: "BRL", intervalo: "mes" } });
    expect(Object.keys(argumentos(escritas()[0]!, "update")?.[0] as object).sort()).toEqual(["plano_agendado_id", "plano_id", "updated_at"]);
  });

  it("controle: sem assinatura no provedor, o link pendente saiu com o preço antigo e é limpo, como no PR 3a", async () => {
    m.linha = { ...EM_TESTE, checkout_url: "https://checkout.stripe.com/c/pay/cs_1" };
    await trocar("pro");
    expect(argumentos(escritas()[0]!, "update")?.[0]).toMatchObject({ checkout_url: null, checkout_expira_em: null });
  });
});
