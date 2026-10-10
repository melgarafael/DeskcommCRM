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
  id, nome: id, preco_cents: 4990, intervalo: "mes", max_assentos: 5, max_canais: 2, arquivado_em: null, oferecido_ao_cliente: true, ...extra,
});
const PLANOS = [
  plano("basico"), plano("pro", { preco_cents: 9990 }), plano("mini", { max_assentos: 1 }), plano("anual", { intervalo: "ano" }),
  plano("negociado", { preco_cents: 2990, oferecido_ao_cliente: false }),
];

interface Mundo { linha: Record<string, unknown> | null; assentos: number; canais: number; casPerdido: boolean }
let m: Mundo;
let banco: BancoFalso;
const trocarNoProvedor = vi.fn<AdaptadorDeCobranca["trocarPlano"]>();

function responder(c: Cadeia): Resposta {
  if (c.tabela === "cobranca_planos") return { data: PLANOS.find((p) => p.id === valorDoFiltro(c, "eq", "id")) ?? null };
  if (c.tabela === "user_organizations") return { count: m.assentos };
  if (c.tabela === "channel_sessions") return { count: m.canais };
  if (operacao(c) === "select") return { data: m.linha };
  return m.casPerdido ? { data: null } : { data: { organization_id: ORG } };
}

const trocar = (planoId: string, origem?: "empresa" | "dono") =>
  trocarPlanoDaOrg(banco.cliente as never, ORG, planoId, {
    adaptador: () => ({ trocarPlano: trocarNoProvedor } as unknown as AdaptadorDeCobranca),
    agora: () => AGORA,
    origem,
  });
const escritas = () => banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update");
const EM_TESTE = { plano_id: "basico", plano_agendado_id: null, estado: "trial", trial_ate: "2026-10-20T00:00:00Z", provedor: null, provedor_assinatura_id: null, proximo_vencimento: null, checkout_url: null, checkout_expira_em: null };
const PAGANDO = { ...EM_TESTE, estado: "ativa", provedor: "stripe", provedor_assinatura_id: "sub_1", proximo_vencimento: "2026-11-01T00:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  m = { linha: { ...EM_TESTE }, assentos: 1, canais: 1, casPerdido: false };
  banco = bancoFalso(responder);
  trocarNoProvedor.mockResolvedValue(undefined);
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
    expect(trocarNoProvedor).toHaveBeenCalledWith({ assinaturaRef: "sub_1", plano: { id: "pro", nome: "pro", precoCents: 9990, intervalo: "mes" } });
  });

  // Divergência 44: a D-13 ("no teste, troca na hora") vale só enquanto NADA foi
  // pago. Com o 1º pagamento confirmado (checkout com < 48 h de teste cobra na
  // hora e vira `ativa`), a troca é agendada, para não reabrir o subir-no-dia-1 da D-3.
  it("⭐ pagou antes do fim do teste (estado ativa): a troca fica AGENDADA para a próxima cobrança paga (Divergência 44)", async () => {
    m.linha = { ...PAGANDO };
    expect(await trocar("pro")).toEqual({
      ok: true, changed: true, quando: "agendado", planoId: "basico", planoAgendadoId: "pro", valeAPartirDe: "2026-11-01T00:00:00Z", de: "basico",
    });
    expect(Object.keys(argumentos(escritas()[0]!, "update")?.[0] as object).sort()).toEqual(["plano_agendado_id", "updated_at"]);
    expect(trocarNoProvedor).toHaveBeenCalledOnce();
  });

  it("voltar ao plano atual desfaz o agendamento (e o preço volta no provedor)", async () => {
    m.linha = { ...PAGANDO, plano_agendado_id: "pro" };
    expect(await trocar("basico")).toMatchObject({ ok: true, quando: "agendado", planoAgendadoId: null });
    expect(argumentos(escritas()[0]!, "update")?.[0]).toMatchObject({ plano_agendado_id: null });
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
    expect(await trocar("pro")).toMatchObject({ ok: false, status: 503, code: "provedor_indisponivel" });
    expect(escritas()).toEqual([]);
  });

  it("⭐ o provedor recusa por período corrente pendente (Asaas): 409 com o código da spec, e nada gravado", async () => {
    m.linha = { ...PAGANDO };
    trocarNoProvedor.mockRejectedValue(new ErroDoProvedor(null, "pagamento_do_periodo_pendente", false));
    expect(await trocar("pro")).toMatchObject({
      ok: false, status: 409, code: "pagamento_do_periodo_pendente", message: FRASE_DO_PERIODO_PENDENTE,
    });
    expect(escritas()).toEqual([]);
  });

  it("outro intervalo: 422 plano_invalido", async () => {
    expect(await trocar("anual")).toMatchObject({ ok: false, status: 422, code: "plano_invalido" });
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
    const r = await trocar("pro");
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as { message: string }).message).toContain("pode estar diferente");
  });

  it("provedor transitório: não afirma 'Nada mudou'", async () => {
    m.linha = { ...PAGANDO };
    trocarNoProvedor.mockRejectedValueOnce(new ErroDoProvedor(503, "api_error", true));
    const r = await trocar("pro");
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
    expect(trocarNoProvedor).toHaveBeenCalledWith({ assinaturaRef: "sub_asaas_1", plano: { id: "pro", nome: "pro", precoCents: 9990, intervalo: "mes" } });
    expect(Object.keys(argumentos(escritas()[0]!, "update")?.[0] as object).sort()).toEqual(["plano_agendado_id", "plano_id", "updated_at"]);
  });

  it("controle: sem assinatura no provedor, o link pendente saiu com o preço antigo e é limpo, como no PR 3a", async () => {
    m.linha = { ...EM_TESTE, checkout_url: "https://checkout.stripe.com/c/pay/cs_1" };
    await trocar("pro");
    expect(argumentos(escritas()[0]!, "update")?.[0]).toMatchObject({ checkout_url: null, checkout_expira_em: null });
  });
});
