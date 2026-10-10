import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, filtros, operacao, type BancoFalso, type Cadeia, type Resposta } from "@/tests/helpers/banco-falso-da-cobranca";

import type { AdaptadorDeCobranca, Situacao } from "@/lib/cobranca/provedores/contrato";

const h = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/cobranca/provedores", () => ({
  adaptador: () => {
    throw new Error("use deps.adaptador no teste");
  },
}));
vi.mock("@/lib/cobranca/emails", () => ({ enviarAvisoAosAdmins: vi.fn() }));
vi.mock("@/lib/cobranca/configuracao", () => ({ toleranciaDias: async () => 7 }));

import { ErroDoProvedor } from "@/lib/cobranca/provedores/contrato";

import { sincronizar, type DependenciasDaCobranca } from "./sincronizar";

const ORG = "bbbbbbbb-0000-4000-8000-000000000001";
const AGORA = new Date("2026-10-10T12:00:00Z");
const HORA = 3_600_000;
const ha = (horas: number) => new Date(AGORA.getTime() - horas * HORA).toISOString();

const LINHA = {
  organization_id: ORG, plano_id: "plano-a", plano_agendado_id: null, estado: "ativa", trial_ate: null,
  provedor: "stripe", provedor_cliente_id: "cus_1", provedor_assinatura_id: "sub_1", vencida_desde: null,
  proximo_vencimento: "2026-11-01T00:00:00.000Z", cancela_no_fim: false, prazo_extra_ate: null,
  ultimo_aviso: null, ultimo_aviso_em: null, relida_em: ha(1), link_de_pagamento: null, assinaturas_vivas: 1,
  checkout_url: null, checkout_expira_em: null, updated_at: ha(1),
};

function situacao(p: Partial<Situacao> = {}): Situacao {
  return {
    assinaturaRef: "sub_1", existe: true, assinaturasVivas: 1, cancelada: false, cancelaNoFim: false, emAtraso: false,
    vencidaDesde: null, proximoVencimento: new Date("2026-11-01T00:00:00Z"), jaPagou: true, emTesteNoProvedorAte: null,
    pagamentoSemAssinaturaViva: false, linkDePagamento: null, statusBruto: "active", ...p,
  };
}

interface Mundo {
  linha: Record<string, unknown> | null;
  org: Record<string, unknown>;
  /** Quantas compare-and-set seguidas perdem; `aoPerder` é o escritor concorrente. */
  casPerdidos: number;
  aoPerder: (() => void) | null;
  avisoGanho: boolean;
  suspensaoAceita: boolean;
}
let m: Mundo;
let banco: BancoFalso;
const ler = vi.fn<AdaptadorDeCobranca["lerSituacao"]>();
const cancelarNoFim = vi.fn<AdaptadorDeCobranca["cancelarNoFim"]>();
const enviarAviso = vi.fn();

function responder(c: Cadeia): Resposta {
  if (c.tabela === "organizations") return { data: m.org };
  if (c.tabela === "agent_inbox_items") return { data: null };
  const op = operacao(c);
  if (op === "select") return { data: m.linha };
  const campos = argumentos(c, "update")?.[0] as Record<string, unknown>;
  const ehCompareAndSet = filtros(c).some((f) => f[0] === "or" || (f[0] === "eq" && f[1] === "updated_at"));
  if (ehCompareAndSet && m.casPerdidos > 0) {
    m.casPerdidos -= 1;
    m.aoPerder?.();
    return { data: null };
  }
  if (m.linha) m.linha = { ...m.linha, ...campos };
  return { data: { organization_id: ORG } };
}

function rpc(nome: string): Resposta {
  if (nome === "fn_cobranca_registrar_aviso") return { data: m.avisoGanho };
  if (nome === "fn_cobranca_suspender_se_devendo") return { data: { changed: m.suspensaoAceita } };
  return { data: { changed: true } };
}

const deps = (): DependenciasDaCobranca => ({
  adaptador: () => ({ lerSituacao: ler, cancelarNoFim } as unknown as AdaptadorDeCobranca),
  agora: () => AGORA,
  tolerancia: async () => 7,
  enviarAviso,
});
const rodar = () => sincronizar(banco.cliente as never, ORG, deps());
const escritas = () => banco.cadeias.filter((c) => c.tabela === "cobranca_assinaturas" && operacao(c) === "update");
const rpcs = (nome: string) => banco.rpcs.filter((r) => r.nome === nome);
const acoes = () => h.audit.mock.calls.map((c) => (c[0] as { action: string }).action);

beforeEach(() => {
  vi.clearAllMocks();
  m = {
    linha: { ...LINHA },
    org: { status: "active", suspended_kind: null, locale: "pt-BR", timezone: "America/Sao_Paulo" },
    casPerdidos: 0,
    aoPerder: null,
    avisoGanho: true,
    suspensaoAceita: true,
  };
  banco = bancoFalso(responder, rpc);
  ler.mockResolvedValue(situacao());
});

describe("sincronizar", () => {
  it("empresa isenta (sem linha): nada lido do provedor, nada escrito", async () => {
    m.linha = null;
    expect(await rodar()).toEqual({ tipo: "isenta" });
    expect(ler).not.toHaveBeenCalled();
    expect(escritas()).toEqual([]);
  });

  it("sem provedor: não chama o provedor, e a régua transforma o teste vencido em dívida com aviso", async () => {
    m.linha = { ...LINHA, provedor: null, provedor_cliente_id: null, provedor_assinatura_id: null, estado: "trial", trial_ate: ha(24), assinaturas_vivas: 0, relida_em: null };
    expect(await rodar()).toEqual({ tipo: "sem_provedor", acao: "avisar" });
    expect(ler).not.toHaveBeenCalled();
    expect(argumentos(escritas()[0]!, "update")?.[0]).toMatchObject({ estado: "em_atraso", vencida_desde: ha(24) });
    expect(rpcs("fn_cobranca_registrar_aviso")[0]?.args).toMatchObject({ p_org: ORG, p_aviso: "venceu", p_severidade: "warn" });
    expect(enviarAviso).toHaveBeenCalledOnce();
  });

  it("⭐ leitura aplicada por compare-and-set em relida_em, com o link de pagamento, e a mudança auditada", async () => {
    ler.mockResolvedValue(situacao({ emAtraso: true, statusBruto: "past_due", linkDePagamento: "https://invoice.stripe.com/i/x" }));
    expect(await rodar()).toEqual({ tipo: "aplicada", estado: "em_atraso", mudou: true, acao: "avisar" });
    const cas = escritas()[0]!;
    expect(argumentos(cas, "update")?.[0]).toMatchObject({
      estado: "em_atraso", vencida_desde: AGORA.toISOString(), relida_em: AGORA.toISOString(),
      link_de_pagamento: "https://invoice.stripe.com/i/x", ultimo_erro: null,
    });
    expect(filtros(cas)).toEqual([
      ["eq", "organization_id", ORG],
      ["eq", "updated_at", LINHA.updated_at],
      ["or", `relida_em.is.null,relida_em.lt."${AGORA.toISOString()}"`],
    ]);
    expect(Object.keys(argumentos(cas, "update")?.[0] as object)).not.toContain("plano_agendado_id");
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.estado_mudou", organizationId: ORG, metadata: { de: "ativa", para: "em_atraso", status_bruto: "past_due" },
    }));
    expect(enviarAviso.mock.calls[0]?.[3]).toBe("https://invoice.stripe.com/i/x");
  });

  it("⭐ leitura mais velha que a já aplicada é descartada: nada de audit, nada de régua", async () => {
    m.casPerdidos = 2;
    ler.mockResolvedValue(situacao({ emAtraso: true }));
    expect(await rodar()).toEqual({ tipo: "descartada" });
    expect(h.audit).not.toHaveBeenCalled();
    expect(banco.rpcs).toEqual([]);
  });

  it("⭐ outro escritor mudou a linha no meio (troca de plano): relê, recalcula e NÃO apaga plano_agendado_id", async () => {
    m.casPerdidos = 1;
    m.aoPerder = () => {
      m.linha = { ...m.linha!, plano_agendado_id: "plano-b", updated_at: ha(0.5) };
    };
    expect(await rodar()).toMatchObject({ tipo: "aplicada" });
    const segunda = escritas()[1]!;
    expect(filtros(segunda)).toContainEqual(["eq", "updated_at", ha(0.5)]);
    expect(Object.keys(argumentos(segunda, "update")?.[0] as object)).not.toContain("plano_agendado_id");
    expect(m.linha?.plano_agendado_id).toBe("plano-b");
  });

  it("⭐ publicação no meio (a linha ficou sem provedor): a leitura da chave velha é descartada e a linha segue em teste", async () => {
    m.casPerdidos = 1;
    m.aoPerder = () => {
      m.linha = { ...m.linha!, provedor: null, provedor_cliente_id: null, provedor_assinatura_id: null, estado: "trial", relida_em: null, updated_at: ha(0.5) };
    };
    expect(await rodar()).toEqual({ tipo: "descartada" });
    expect(m.linha?.estado).toBe("trial");
    expect(escritas()).toHaveLength(1);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("⭐ provedor fora do ar: grava só o erro, e o estado fica intacto", async () => {
    ler.mockRejectedValue(new ErroDoProvedor(503, "api_error", true));
    expect(await rodar()).toEqual({ tipo: "falhou", erro: "provedor_fora", transitorio: true });
    expect(Object.keys(argumentos(escritas()[0]!, "update")?.[0] as object).sort()).toEqual(["ultimo_erro", "ultimo_erro_em"]);
    expect(banco.rpcs).toEqual([]);
  });

  it("⭐ cliente que não existe na conta nova (chave de outra conta) vira leitura_invalida e o estado fica intacto", async () => {
    ler.mockRejectedValue(new ErroDoProvedor(404, "resource_missing", false));
    expect(await rodar()).toEqual({ tipo: "falhou", erro: "leitura_invalida", transitorio: false });
    expect(argumentos(escritas()[0]!, "update")?.[0]).toEqual({ ultimo_erro: "leitura_invalida", ultimo_erro_em: AGORA.toISOString() });
  });

  it("pagou: volta a ativa, fecha os avisos da régua na Central e reativa a suspensa por cobrança", async () => {
    m.linha = { ...LINHA, estado: "em_atraso", vencida_desde: ha(240), ultimo_aviso: "suspensa", ultimo_aviso_em: ha(24) };
    m.org = { ...m.org, status: "suspended", suspended_kind: "cobranca" };
    expect(await rodar()).toMatchObject({ tipo: "aplicada", estado: "ativa", acao: "reativar" });
    expect(argumentos(escritas()[0]!, "update")?.[0]).toMatchObject({ ultimo_aviso: null, ultimo_aviso_em: null, vencida_desde: null });
    const fechou = banco.cadeias.find((c) => c.tabela === "agent_inbox_items");
    expect(filtros(fechou!)).toEqual([["eq", "organization_id", ORG], ["eq", "kind", "cobranca"], ["is", "ref_kind", null], ["eq", "status", "open"]]);
    expect(rpcs("fn_reativar_organizacao")[0]?.args).toEqual({ p_org: ORG, p_kind_exigido: "cobranca", p_ator: null });
    expect(acoes()).toEqual(["cobranca.estado_mudou", "cobranca.org_reativada"]);
  });

  it("limite passado, aviso final de 49 h e leitura fresca: suspende, registra 'suspensa' e audita", async () => {
    m.linha = { ...LINHA, estado: "em_atraso", vencida_desde: ha(24 * 8), ultimo_aviso: "suspende_em_breve", ultimo_aviso_em: ha(49) };
    ler.mockResolvedValue(situacao({ emAtraso: true, statusBruto: "past_due" }));
    expect(await rodar()).toMatchObject({ acao: "suspender" });
    expect(rpcs("fn_cobranca_suspender_se_devendo")[0]?.args).toEqual({ p_org: ORG, p_motivo: "Falta de pagamento" });
    expect(rpcs("fn_suspender_organizacao")).toEqual([]);
    expect(rpcs("fn_cobranca_registrar_aviso")[0]?.args).toMatchObject({ p_aviso: "suspensa", p_severidade: "critical" });
    expect(acoes()).toContain("cobranca.org_suspensa");
  });

  it("⭐ pagou entre a decisão e a suspensão (a função SQL recusa): nada de suspensa, de audit nem de e-mail", async () => {
    m.linha = { ...LINHA, estado: "em_atraso", vencida_desde: ha(24 * 8), ultimo_aviso: "suspende_em_breve", ultimo_aviso_em: ha(49) };
    m.suspensaoAceita = false;
    ler.mockResolvedValue(situacao({ emAtraso: true, statusBruto: "past_due" }));
    expect(await rodar()).toMatchObject({ acao: "nada" });
    expect(acoes()).not.toContain("cobranca.org_suspensa");
    expect(rpcs("fn_cobranca_registrar_aviso")).toEqual([]);
    expect(enviarAviso).not.toHaveBeenCalled();
  });

  it("org redigida com assinatura viva: cancela no provedor uma vez e marca cancela_no_fim", async () => {
    m.org = { ...m.org, status: "redacted", suspended_kind: null };
    expect(await rodar()).toMatchObject({ acao: "cancelar_no_provedor" });
    expect(cancelarNoFim).toHaveBeenCalledWith("sub_1");
    expect(argumentos(escritas().at(-1)!, "update")?.[0]).toMatchObject({ cancela_no_fim: true });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "cobranca.assinatura_cancelada", metadata: { motivo: "org_redigida" } }));
  });

  it("o plano agendado que virou na leitura é auditado como 'aplicado'", async () => {
    m.linha = { ...LINHA, plano_agendado_id: "plano-b", proximo_vencimento: "2026-10-11T00:00:00.000Z" };
    ler.mockResolvedValue(situacao({ proximoVencimento: new Date("2026-11-11T00:00:00Z") }));
    await rodar();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "cobranca.plano_trocado", metadata: { de: "plano-a", para: "plano-b", quando: "aplicado" },
    }));
  });

  it("aviso que outro processo já deu (a função devolve false): nenhum e-mail", async () => {
    m.avisoGanho = false;
    ler.mockResolvedValue(situacao({ emAtraso: true }));
    expect(await rodar()).toMatchObject({ acao: "nada" });
    expect(enviarAviso).not.toHaveBeenCalled();
  });
  it("⭐ checkout em andamento (reserva sem link, prazo vivo): a leitura NÃO a limpa — a fase 3 do checkout a fecha", async () => {
    m.linha = { ...LINHA, checkout_url: null, checkout_expira_em: new Date(AGORA.getTime() + 2 * 60_000).toISOString() };
    ler.mockResolvedValue(situacao({ assinaturasVivas: 1 }));
    await rodar();
    const campos = argumentos(escritas()[0]!, "update")?.[0] as Record<string, unknown>;
    expect(Object.keys(campos)).not.toContain("checkout_expira_em");
    expect(Object.keys(campos)).not.toContain("checkout_url");
  });

  it("link de checkout já gravado e assinatura viva: a leitura limpa o checkout (ele já foi usado)", async () => {
    m.linha = { ...LINHA, checkout_url: "https://checkout.example.com/x", checkout_expira_em: new Date(AGORA.getTime() + 60 * 60_000).toISOString() };
    ler.mockResolvedValue(situacao({ assinaturasVivas: 1 }));
    await rodar();
    expect(argumentos(escritas()[0]!, "update")?.[0]).toMatchObject({ checkout_url: null, checkout_expira_em: null });
  });

  it("⭐ assinatura que morreu com plano agendado: o agendado é apagado da linha, e o plano atual fica", async () => {
    m.linha = { ...LINHA, plano_agendado_id: "plano-b" };
    ler.mockResolvedValue(situacao({ cancelada: true, existe: false, assinaturasVivas: 0, statusBruto: "canceled" }));
    await rodar();
    const campos = argumentos(escritas()[0]!, "update")?.[0] as Record<string, unknown>;
    expect(campos).toMatchObject({ estado: "cancelada", plano_agendado_id: null });
    expect(Object.keys(campos)).not.toContain("plano_id");
    expect(acoes()).not.toContain("cobranca.plano_trocado");
  });
});
