/**
 * As seis capacidades do pacote `reter`, contra os handlers REAIS.
 *
 * O que estes testes guardam:
 *
 *  1. **O anti-morte funciona pela porta que o dono liga na tela.** Agendar um
 *     retorno tem de chegar ao banco e emitir atividade — a capacidade existir no
 *     catálogo e não fazer nada é o modo de falha que o gate de texto não pega.
 *
 *  2. **Recusa de negócio é RESPOSTA, não exceção.** "Já existe retorno vivo" e
 *     "essa oportunidade não existe" precisam voltar como ensino: uma exceção faz
 *     o modelo tentar de novo igual, e o turno queima passos até o teto.
 *
 *  3. **Toda escrita emite `crm_lead_activities`.** É o invariante 3 da doutrina,
 *     e é comportamental — um comentário no topo do arquivo dizendo "emite
 *     atividade" passa no typecheck e no lint com texto falso dentro.
 */
import { describe, expect, it, vi } from "vitest";

import {
  crmScheduleFollowup,
  crmCancelFollowup,
  crmListFollowups,
  crmCloseDemand,
  crmProposeReactivation,
  crmListAtRiskLeads,
} from "@/lib/mcp/tools/retencao";
import { ACTIVITY_LABELS } from "@/lib/leads/activity-vocabulary";
import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const ORG = "aaaaaaaa-1111-4111-8111-111111111111";
const LEAD = "aaaaaaaa-2222-4222-8222-222222222222";
const CONTATO = "aaaaaaaa-3333-4333-8333-333333333333";
const RETORNO = "aaaaaaaa-4444-4444-8444-444444444444";
const STAGE = "aaaaaaaa-5555-4555-8555-555555555555";
const STAGE_PERDA = "aaaaaaaa-6666-4666-8666-666666666666";

type Op = "select" | "insert" | "update";
type Terminal = "maybeSingle" | "single" | "list";

interface Consulta {
  table: string;
  op: Op;
  terminal: Terminal;
  /** Colunas do select — distingue duas leituras da mesma tabela. */
  cols: string;
  filtros: Record<string, unknown>;
}

type Resolver = (c: Consulta) => { data?: unknown; error?: unknown };

interface Capturas {
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
}

function novasCapturas(): Capturas {
  return { inserts: [], updates: [], rpcs: [] };
}

/**
 * Stub do client. Registra a consulta e delega a resposta ao resolver do teste —
 * mesmo desenho de `mcp-governance-tools.test.ts`, com `insert`/`single` a mais
 * porque agendar cria linha e lê de volta.
 */
function fakeSupabase(resolve: Resolver, cap: Capturas) {
  const from = (table: string) => {
    const c: Consulta = { table, op: "select", terminal: "list", cols: "", filtros: {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (cols: string) => {
        c.cols = cols;
        return chain;
      },
      insert: (values: Record<string, unknown>) => {
        cap.inserts.push({ table, values });
        c.op = "insert";
        return chain;
      },
      update: (values: Record<string, unknown>) => {
        cap.updates.push({ table, values });
        c.op = "update";
        return chain;
      },
      eq: (col: string, val: unknown) => {
        c.filtros[col] = val;
        return chain;
      },
      in: () => chain,
      is: () => chain,
      gt: () => chain,
      lt: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(resolve({ ...c, terminal: "maybeSingle" })),
      single: () => Promise.resolve(resolve({ ...c, terminal: "single" })),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(resolve({ ...c, terminal: "list" })).then(res),
    };
    return chain;
  };
  return {
    from,
    rpc: (fn: string, args: Record<string, unknown>) => {
      cap.rpcs.push({ fn, args });
      if (fn === 'fn_service_begin') return Promise.resolve({ data: { organization_id: ORG, contact_id: CONTATO, conversation_id: 'conv-1', service_revision: 1, demanda_id: null, demanda_revision: null, status: 'open', demanda_fechada_em: null }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function ctxDe(resolve: Resolver, cap: Capturas): McpContext {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "agente-1", role: "agent", api_token_id: "tok" },
    apiTokenId: "tok",
    requestId: "req-1",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: fakeSupabase(resolve, cap) as any,
  } as McpContext;
}

/** Quando o agendamento chega ao fim: negócio existe, contato existe, sem retorno vivo. */
const caminhoLivre: Resolver = (c) => {
  if (c.table === "crm_leads" && c.terminal === "maybeSingle") {
    return { data: { id: LEAD, contact_id: CONTATO, stage_id: STAGE, status: "open" }, error: null };
  }
  if (c.table === "cron_jobs" && c.op === "insert") {
    return {
      data: {
        id: RETORNO,
        contact_id: CONTATO,
        next_run_at: "2026-08-06T13:00:00.000Z",
        enabled: true,
        payload: { reason: "reconfirmar", promise: "volto quarta", promised_at: "2026-08-06T13:00:00Z" },
        cancelled_at: null,
        cancel_reason: null,
      },
      error: null,
    };
  }
  return { data: c.terminal === "list" ? [] : null, error: null };
};

/** Um instante sempre dentro da janela padrão (5 min … 180 dias). */
function daquiADias(dias: number): string {
  return new Date(Date.now() + dias * 86_400_000).toISOString();
}

describe("crm_schedule_followup", () => {
  it("agenda, grava o retorno e EMITE atividade na timeline do negócio", async () => {
    const cap = novasCapturas();
    const res = (await crmScheduleFollowup.handler(
      {
        lead_id: LEAD,
        contact_id: undefined,
        promised_at: daquiADias(2),
        in_hours: undefined,
        reason: "reconfirmar a consulta",
        promise: "confirmo com você na quarta",
        context: undefined,
      },
      ctxDe(caminhoLivre, cap),
    )) as { agendado: boolean; retorno_id: string; lead_id: string | null };

    expect(res.agendado).toBe(true);
    expect(res.retorno_id).toBe(RETORNO);
    expect(res.lead_id).toBe(LEAD);

    const cron = cap.inserts.find((i) => i.table === "cron_jobs");
    expect(cron?.values.organization_id).toBe(ORG);
    expect(cron?.values.contact_id).toBe(CONTATO);
    expect(cron?.values.job_kind).toBe("followup_turn");

    // O INVARIANTE 3: sem esta linha o retorno existe no banco e some da vida do
    // negócio — o card para de esfriar e ninguém sabe dizer por quê.
    const atividade = cap.inserts.find((i) => i.table === "crm_lead_activities");
    expect(atividade?.values.type).toBe("followup_scheduled");
    expect(atividade?.values.lead_id).toBe(LEAD);
    expect(atividade?.values.organization_id).toBe(ORG);
  });

  it("já existe retorno vivo → ensina e NÃO cria o segundo", async () => {
    const cap = novasCapturas();
    const comRetornoVivo: Resolver = (c) => {
      if (c.table === "cron_jobs" && c.op === "select" && c.terminal === "list") {
        return {
          data: [
            {
              id: RETORNO,
              contact_id: CONTATO,
              next_run_at: "2026-08-06T13:00:00.000Z",
              enabled: true,
              payload: { reason: "já marcado", promised_at: "2026-08-06T13:00:00Z" },
              cancelled_at: null,
              cancel_reason: null,
            },
          ],
          error: null,
        };
      }
      return caminhoLivre(c);
    };

    const res = (await crmScheduleFollowup.handler(
      {
        lead_id: LEAD,
        contact_id: undefined,
        promised_at: daquiADias(2),
        in_hours: undefined,
        reason: "de novo",
        promise: "volto",
        context: undefined,
      },
      ctxDe(comRetornoVivo, cap),
    )) as { agendado: boolean; motivo: string; mensagem: string };

    expect(res.agendado).toBe(false);
    expect(res.motivo).toBe("ja_existe_retorno");
    expect(cap.inserts.filter((i) => i.table === "cron_jobs")).toHaveLength(0);
  });

  /**
   * ⚠️ O CAMPO OPCIONAL PREENCHIDO COM LIXO NÃO PODE MATAR A CHAMADA BOA.
   *
   * Achado num turno de modelo REAL: `lead_id` é opcional na assinatura, e o
   * modelo preencheu `00000000-0000-0000-0000-000000000000` — o placeholder que
   * ele usa para "não tenho este campo" — junto com um `contact_id` CORRETO,
   * vindo da busca que ele mesmo acabara de fazer. A precedência antiga (lead
   * primeiro, sempre) deixava o campo-lixo envenenar a chamada: eu recusava com
   * "confira a capacidade de listar oportunidades" tendo em mãos tudo o que
   * precisava para marcar o retorno.
   *
   * Nenhum teste com humano no comando geraria esse payload.
   */
  it("lead_id que não existe + contact_id válido: agenda pelo cliente, não recusa", async () => {
    const cap = novasCapturas();
    const leadFantasma: Resolver = (c) => {
      // O `crm_leads` do maybeSingle é a resolução do alvo: devolve NADA para o
      // id-placeholder. O `contacts` confirma que o cliente existe.
      if (c.table === "crm_leads" && c.terminal === "maybeSingle") return { data: null, error: null };
      if (c.table === "contacts" && c.terminal === "maybeSingle") return { data: { id: CONTATO }, error: null };
      return caminhoLivre(c);
    };

    const res = (await crmScheduleFollowup.handler(
      {
        lead_id: "00000000-0000-0000-0000-000000000000",
        contact_id: CONTATO,
        promised_at: daquiADias(3),
        in_hours: undefined,
        reason: "cliente pediu para decidir com calma",
        promise: "volto em três dias",
        context: undefined,
      },
      ctxDe(leadFantasma, cap),
    )) as { agendado: boolean; contact_id?: string; motivo?: string };

    expect(res.agendado).toBe(true);
    expect(res.contact_id).toBe(CONTATO);
    expect(cap.inserts.some((i) => i.table === "cron_jobs")).toBe(true);
  });

  it("lead_id que não existe e SEM contact_id continua sendo recusa", async () => {
    // A tolerância acima vale só quando sobra informação boa. Sem cliente, não
    // há para quem voltar a falar, e inventar um alvo seria pior que recusar.
    const cap = novasCapturas();
    const res = (await crmScheduleFollowup.handler(
      {
        lead_id: "00000000-0000-0000-0000-000000000000",
        contact_id: undefined,
        promised_at: daquiADias(3),
        in_hours: undefined,
        reason: "x",
        promise: "y",
        context: undefined,
      },
      ctxDe(() => ({ data: null, error: null }), cap),
    )) as { agendado: boolean; motivo: string };

    expect(res.agendado).toBe(false);
    expect(res.motivo).toBe("negocio_nao_encontrado");
  });

  /**
   * ⚠️ O PRAZO RELATIVO EXISTE PORQUE O AGENTE NÃO TEM RELÓGIO.
   *
   * Medido em turnos com modelo real, dois modelos diferentes, mesmo cenário
   * ("retornar daqui a três dias"): um mandou `2023-10-13` — a data do próprio
   * treino — e o outro se RECUSOU a inventar ("qual data e horário exatos devo
   * usar?"). Nenhum dos dois agendou. O runtime nunca diz ao agente que instante
   * é agora, e a capacidade exigia exatamente isso.
   *
   * A conversão acontece AQUI, com o relógio do servidor. O que fica GRAVADO
   * continua sendo o instante absoluto — a promessa é lida dias depois.
   */
  it("in_hours é convertido para instante absoluto com o relógio do servidor", async () => {
    const cap = novasCapturas();
    const antes = Date.now();
    const res = (await crmScheduleFollowup.handler(
      {
        lead_id: LEAD,
        contact_id: undefined,
        promised_at: undefined,
        in_hours: 72,
        reason: "cliente pediu três dias para decidir",
        promise: "volto em três dias",
        context: undefined,
      },
      ctxDe(caminhoLivre, cap),
    )) as { agendado: boolean };

    expect(res.agendado).toBe(true);
    const cron = cap.inserts.find((i) => i.table === "cron_jobs");
    const payload = cron?.values.payload as { promised_at: string };
    const gravado = Date.parse(payload.promised_at);
    // 72 h à frente, com folga para o tempo de execução do próprio teste.
    expect(gravado).toBeGreaterThan(antes + 71.9 * 3_600_000);
    expect(gravado).toBeLessThan(antes + 72.1 * 3_600_000);
  });

  it("sem in_hours e sem promised_at, ensina o QUANDO em vez de estourar", async () => {
    const cap = novasCapturas();
    const res = (await crmScheduleFollowup.handler(
      {
        lead_id: LEAD,
        contact_id: undefined,
        promised_at: undefined,
        in_hours: undefined,
        reason: "x",
        promise: "y",
        context: undefined,
      },
      ctxDe(caminhoLivre, cap),
    )) as { agendado: boolean; motivo: string; mensagem: string };

    expect(res.agendado).toBe(false);
    expect(res.motivo).toBe("quando_ausente");
    expect(res.mensagem).toContain("in_hours");
    expect(cap.inserts.filter((i) => i.table === "cron_jobs")).toHaveLength(0);
  });

  /**
   * ⚠️ A PRECEDÊNCIA FOI DECIDIDA PELA MEDIÇÃO, e ela desmentiu a intuição.
   *
   * A primeira versão preferia `promised_at` ("instante explícito é mais
   * específico que prazo"). No turno real o modelo mandou os DOIS: `in_hours: 72`
   * — a expressão fiel do que foi combinado — e um `promised_at` fabricado a
   * partir da data de criação do contato, porque ele não sabe que dia é hoje.
   * Preferir o campo explícito era preferir o palpite ao dado.
   */
  it("in_hours vence promised_at quando os dois vêm — o prazo é o dado confiável", async () => {
    const cap = novasCapturas();
    const palpiteDoModelo = "2023-10-13T10:00:00Z";
    const antes = Date.now();
    const res = (await crmScheduleFollowup.handler(
      {
        lead_id: LEAD,
        contact_id: undefined,
        promised_at: palpiteDoModelo,
        in_hours: 72,
        reason: "x",
        promise: "y",
        context: undefined,
      },
      ctxDe(caminhoLivre, cap),
    )) as { agendado: boolean };

    // Com a precedência antiga isto seria uma data de 2023 e a chamada morreria
    // em "instante_no_passado" — exatamente o que aconteceu no turno medido.
    expect(res.agendado).toBe(true);
    const cron = cap.inserts.find((i) => i.table === "cron_jobs");
    const gravado = Date.parse((cron?.values.payload as { promised_at: string }).promised_at);
    expect(gravado).toBeGreaterThan(antes + 71.9 * 3_600_000);
  });

  it("promised_at sozinho continua valendo — quem sabe o instante manda o instante", async () => {
    const cap = novasCapturas();
    const alvo = daquiADias(2);
    await crmScheduleFollowup.handler(
      {
        lead_id: LEAD,
        contact_id: undefined,
        promised_at: alvo,
        in_hours: undefined,
        reason: "x",
        promise: "y",
        context: undefined,
      },
      ctxDe(caminhoLivre, cap),
    );
    const cron = cap.inserts.find((i) => i.table === "cron_jobs");
    expect((cron?.values.payload as { promised_at: string }).promised_at).toBe(alvo);
  });

  it("data relativa ('amanhã') vira ensino, não exceção", async () => {
    const cap = novasCapturas();
    const res = (await crmScheduleFollowup.handler(
      {
        lead_id: LEAD,
        contact_id: undefined,
        promised_at: "amanhã de manhã",
        in_hours: undefined,
        reason: "x",
        promise: "y",
        context: undefined,
      },
      ctxDe(caminhoLivre, cap),
    )) as { agendado: boolean; motivo: string; mensagem: string };

    expect(res.agendado).toBe(false);
    expect(res.motivo).toBe("instante_invalido");
    expect(res.mensagem).toContain("ISO 8601");
  });

  /**
   * ⚠️ A RECUSA TEM DE DIZER QUE HORAS SÃO — achado num turno de modelo REAL.
   *
   * Pedido para marcar "daqui a três dias", o modelo mandou `2023-10-13`: a data
   * do treino dele. A recusa antiga dizia só "a data já passou", que é verdade e
   * é inútil — sem saber o AGORA ele repetiu a MESMA data na tentativa seguinte e
   * o turno morreu sem agendar nada.
   *
   * Recusa que não devolve o que falta para corrigir não é ensino, é obstáculo.
   */
  it("recusa de data no passado devolve o instante ATUAL, para o modelo poder corrigir", async () => {
    const cap = novasCapturas();
    const res = (await crmScheduleFollowup.handler(
      {
        lead_id: LEAD,
        contact_id: undefined,
        promised_at: "2023-10-13T10:00:00Z",
        in_hours: undefined,
        reason: "x",
        promise: "y",
        context: undefined,
      },
      ctxDe(caminhoLivre, cap),
    )) as { agendado: boolean; motivo: string; mensagem: string };

    expect(res.agendado).toBe(false);
    expect(res.motivo).toBe("instante_no_passado");
    // O ano corrente na mensagem é o que permite ao modelo somar o prazo.
    expect(res.mensagem).toContain(String(new Date().getUTCFullYear()));
    expect(res.mensagem.toUpperCase()).toContain("AGORA");
  });

  it("negócio sem cliente vinculado é recusado — não há para quem voltar a falar", async () => {
    const cap = novasCapturas();
    const semContato: Resolver = (c) =>
      c.table === "crm_leads" && c.terminal === "maybeSingle"
        ? { data: { id: LEAD, contact_id: null }, error: null }
        : caminhoLivre(c);

    const res = (await crmScheduleFollowup.handler(
      {
        lead_id: LEAD,
        contact_id: undefined,
        promised_at: daquiADias(2),
        in_hours: undefined,
        reason: "x",
        promise: "y",
        context: undefined,
      },
      ctxDe(semContato, cap),
    )) as { agendado: boolean; motivo: string };

    expect(res.agendado).toBe(false);
    expect(res.motivo).toBe("negocio_sem_contato");
    expect(cap.inserts.filter((i) => i.table === "cron_jobs")).toHaveLength(0);
  });
});

describe("crm_cancel_followup", () => {
  const retornoAgendado = {
    id: RETORNO,
    contact_id: CONTATO,
    next_run_at: "2026-08-06T13:00:00.000Z",
    enabled: true,
    payload: { reason: "reconfirmar" },
    cancelled_at: null,
    cancel_reason: null,
  };

  it("cancela, marca o motivo no banco e EMITE atividade", async () => {
    const cap = novasCapturas();
    const resolver: Resolver = (c) => {
      if (c.table === "cron_jobs" && c.op === "select" && c.terminal === "maybeSingle") {
        return { data: retornoAgendado, error: null };
      }
      if (c.table === "cron_jobs" && c.op === "update") return { data: [{ id: RETORNO }], error: null };
      if (c.table === "crm_leads" && c.terminal === "list") {
        return {
          data: [
            {
              id: LEAD,
              organization_id: ORG,
              pipeline_id: "p1",
              status: "open",
              last_activity_at: null,
              created_at: "2026-08-01T00:00:00Z",
            },
          ],
          error: null,
        };
      }
      if (c.table === "contacts" && c.terminal === "maybeSingle") {
        return { data: { id: CONTATO }, error: null };
      }
      return { data: c.terminal === "list" ? [] : null, error: null };
    };

    const res = (await crmCancelFollowup.handler(
      { followup_id: RETORNO, reason: "o cliente já respondeu" },
      ctxDe(resolver, cap),
    )) as { cancelado: boolean; lead_id: string | null };

    expect(res.cancelado).toBe(true);
    const upd = cap.updates.find((u) => u.table === "cron_jobs");
    expect(upd?.values.enabled).toBe(false);
    expect(upd?.values.cancel_reason).toBe("o cliente já respondeu");
    expect(upd?.values.cancelled_at).toBeTruthy();

    // É por esta linha que o AGENTE descobre, ao retomar, que desmarcaram.
    const atividade = cap.inserts.find((i) => i.table === "crm_lead_activities");
    expect(atividade?.values.type).toBe("followup_cancelled");
    expect(atividade?.values.lead_id).toBe(LEAD);
  });

  it("retorno já disparado → cancelado=false e NENHUM update", async () => {
    const cap = novasCapturas();
    const jaDisparado: Resolver = (c) =>
      c.table === "cron_jobs" && c.terminal === "maybeSingle"
        ? { data: { ...retornoAgendado, enabled: false }, error: null }
        : { data: c.terminal === "list" ? [] : null, error: null };

    const res = (await crmCancelFollowup.handler(
      { followup_id: RETORNO, reason: "tarde demais" },
      ctxDe(jaDisparado, cap),
    )) as { cancelado: boolean; motivo: string };

    expect(res.cancelado).toBe(false);
    expect(res.motivo).toBe("ja_encerrado");
    expect(cap.updates).toHaveLength(0);
  });
});

describe("crm_list_followups", () => {
  it("devolve a situação de cada retorno, inclusive o cancelado com o motivo", async () => {
    const cap = novasCapturas();
    const resolver: Resolver = (c) => {
      if (c.table === "crm_leads" && c.terminal === "maybeSingle") {
        return { data: { id: LEAD, contact_id: CONTATO }, error: null };
      }
      if (c.table === "cron_jobs" && c.terminal === "list") {
        return {
          data: [
            {
              id: RETORNO,
              contact_id: CONTATO,
              next_run_at: "2026-08-06T13:00:00.000Z",
              enabled: false,
              payload: { reason: "reconfirmar" },
              cancelled_at: "2026-08-05T10:00:00.000Z",
              cancel_reason: "desmarcado por uma pessoa da equipe",
            },
          ],
          error: null,
        };
      }
      return { data: c.terminal === "list" ? [] : null, error: null };
    };

    const res = (await crmListFollowups.handler(
      { lead_id: LEAD, contact_id: undefined, limit: 20 },
      ctxDe(resolver, cap),
    )) as {
      retornos: Array<{ situacao: string; motivo_do_cancelamento: string | null }>;
    };

    // "cancelado" e "disparado" têm `enabled = false` no banco. Se esta asserção
    // virar "disparado", o agente passa a achar que a mensagem foi enviada.
    expect(res.retornos[0]?.situacao).toBe("cancelado");
    expect(res.retornos[0]?.motivo_do_cancelamento).toBe("desmarcado por uma pessoa da equipe");
  });
});

describe("crm_close_demand", () => {
  const leadAberto = {
    id: LEAD,
    organization_id: ORG,
    pipeline_id: "p1",
    stage_id: STAGE,
    status: "open",
    contact_id: CONTATO,
  };

  it("encerra como perdido, exige o motivo e EMITE atividade", async () => {
    const cap = novasCapturas();
    const resolver: Resolver = (c) => {
      if (c.table === "crm_leads" && c.terminal === "maybeSingle") return { data: leadAberto, error: null };
      if (c.table === "crm_stages" && c.terminal === "maybeSingle") {
        return { data: { id: STAGE_PERDA, name: "Perdido" }, error: null };
      }
      return { data: c.terminal === "list" ? [] : null, error: null };
    };

    const res = (await crmCloseDemand.handler(
      { lead_id: LEAD, outcome: "lost", reason: "sem orçamento" },
      ctxDe(resolver, cap),
    )) as { encerrado: boolean };

    expect(res.encerrado).toBe(true);
    const upd = cap.updates.find((u) => u.table === "crm_leads");
    expect(upd?.values.stage_id).toBe(STAGE_PERDA);
    expect(upd?.values.lost_reason).toBe("sem orçamento");
    // `status` NUNCA vem daqui — quem escreve é o trigger. Duas fontes para a
    // mesma verdade é como o status e o estágio divergem sem ninguém ver.
    expect(upd?.values.status).toBeUndefined();

    const atividade = cap.inserts.find((i) => i.table === "crm_lead_activities");
    expect(atividade?.values.type).toBe("demand_closed");
    expect(String(atividade?.values.reason)).toContain("sem orçamento");
  });

  it("perder sem motivo é recusado como ensino, e nada é escrito", async () => {
    const cap = novasCapturas();
    const res = (await crmCloseDemand.handler(
      { lead_id: LEAD, outcome: "lost", reason: undefined },
      ctxDe(() => ({ data: null, error: null }), cap),
    )) as { encerrado: boolean; motivo: string };

    expect(res.encerrado).toBe(false);
    expect(res.motivo).toBe("validation_failed");
    expect(cap.updates).toHaveLength(0);
  });

  it("funil sem estágio terminal vira ensino, não exceção", async () => {
    const cap = novasCapturas();
    const semEstagio: Resolver = (c) => {
      if (c.table === "crm_leads" && c.terminal === "maybeSingle") return { data: leadAberto, error: null };
      return { data: null, error: null };
    };

    const res = (await crmCloseDemand.handler(
      { lead_id: LEAD, outcome: "won", reason: undefined },
      ctxDe(semEstagio, cap),
    )) as { encerrado: boolean; motivo: string };

    expect(res.encerrado).toBe(false);
    expect(res.motivo).toBe("pipeline_no_won_stage");
  });
});

describe("crm_propose_reactivation", () => {
  it("recusa negócio já encerrado — não há contato a retomar", async () => {
    const cap = novasCapturas();
    const encerrado: Resolver = (c) =>
      c.table === "crm_leads" && c.terminal === "maybeSingle"
        ? { data: { id: LEAD, contact_id: CONTATO, stage_id: STAGE, status: "won" }, error: null }
        : { data: null, error: null };

    const res = (await crmProposeReactivation.handler({ lead_id: LEAD }, ctxDe(encerrado, cap))) as {
      proposta_criada: boolean;
      motivo: string;
    };

    expect(res.proposta_criada).toBe(false);
    expect(res.motivo).toBe("negocio_encerrado");
    expect(cap.inserts.filter((i) => i.table === "crm_lead_reactivations")).toHaveLength(0);
  });

  it("cria a proposta e devolve quando ela vence", async () => {
    const cap = novasCapturas();
    const resolver: Resolver = (c) => {
      if (c.table === "crm_leads" && c.terminal === "maybeSingle") {
        return { data: { id: LEAD, contact_id: CONTATO, stage_id: STAGE, status: "open" }, error: null };
      }
      if (c.table === "crm_stages" && c.terminal === "maybeSingle") {
        return { data: { expected_duration_hours: 48 }, error: null };
      }
      if (c.table === "crm_lead_reactivations" && c.op === "insert") {
        return { data: { id: "prop-1" }, error: null };
      }
      return { data: null, error: null };
    };

    const res = (await crmProposeReactivation.handler({ lead_id: LEAD }, ctxDe(resolver, cap))) as {
      proposta_criada: boolean;
      vence_em: string;
    };

    expect(res.proposta_criada).toBe(true);
    // A janela da proposta é a MESMA do esfriamento do estágio (48 h aqui). Uma
    // proposta que vence noutro ritmo faria o negócio sumir do quadro numa
    // cadência que ninguém configurou.
    const venceEm = new Date(res.vence_em).getTime() - Date.now();
    expect(venceEm).toBeGreaterThan(47 * 3_600_000);
    expect(venceEm).toBeLessThan(49 * 3_600_000);
  });
});

/**
 * O `reason` NÃO REPETE O RÓTULO — a guarda que faltava.
 *
 * ⚠️ ESTE BLOCO NASCEU DE UM DEFEITO QUE NENHUM TESTE PEGOU. A timeline mostra o
 * rótulo do tipo e, embaixo, o reason. Com o reason começando pela mesma frase, o
 * dossiê exibia "Retorno agendado / Retorno agendado — reconfirmar a proposta".
 * Tudo verde, e a leitura burra.
 *
 * O motivo de nenhum teste pegar é instrutivo: as asserções eram sobre
 * `toContain(motivo)` — sobre o que PRECISA estar lá. Nada dizia o que NÃO pode
 * estar. Foi preciso abrir o dossiê no navegador para ver.
 */
describe("o texto que aparece na linha do tempo", () => {
  const semRedundancia = (rotulo: string, reason: string) =>
    !reason.toLowerCase().startsWith(rotulo.toLowerCase());

  it("agendar: o reason conta o PORQUÊ, não repete 'Retorno agendado'", async () => {
    const cap = novasCapturas();
    await crmScheduleFollowup.handler(
      {
        lead_id: LEAD,
        contact_id: undefined,
        promised_at: daquiADias(2),
        in_hours: undefined,
        reason: "reconfirmar a proposta",
        promise: "volto quarta",
        context: undefined,
      },
      ctxDe(caminhoLivre, cap),
    );
    const reason = String(
      cap.inserts.find((i) => i.table === "crm_lead_activities")?.values.reason,
    );
    expect(semRedundancia(ACTIVITY_LABELS.followup_scheduled, reason)).toBe(true);
    expect(reason).toContain("Reconfirmar a proposta");
  });

  it("cancelar: idem, e o motivo entra com inicial maiúscula", async () => {
    const cap = novasCapturas();
    const resolver: Resolver = (c) => {
      if (c.table === "cron_jobs" && c.op === "select" && c.terminal === "maybeSingle") {
        return {
          data: {
            id: RETORNO,
            contact_id: CONTATO,
            next_run_at: "2026-08-06T13:00:00.000Z",
            enabled: true,
            payload: {},
            cancelled_at: null,
            cancel_reason: null,
          },
          error: null,
        };
      }
      if (c.table === "cron_jobs" && c.op === "update") return { data: [{ id: RETORNO }], error: null };
      if (c.table === "crm_leads" && c.terminal === "list") {
        return {
          data: [
            {
              id: LEAD,
              organization_id: ORG,
              pipeline_id: "p1",
              status: "open",
              last_activity_at: null,
              created_at: "2026-08-01T00:00:00Z",
            },
          ],
          error: null,
        };
      }
      if (c.table === "contacts" && c.terminal === "maybeSingle") return { data: { id: CONTATO }, error: null };
      return { data: c.terminal === "list" ? [] : null, error: null };
    };
    await crmCancelFollowup.handler(
      { followup_id: RETORNO, reason: "o cliente já respondeu" },
      ctxDe(resolver, cap),
    );
    const reason = String(
      cap.inserts.find((i) => i.table === "crm_lead_activities")?.values.reason,
    );
    expect(semRedundancia(ACTIVITY_LABELS.followup_cancelled, reason)).toBe(true);
    expect(reason).toBe("O cliente já respondeu");
  });

  it("encerrar: o reason acrescenta o desfecho, não repete 'Demanda encerrada'", async () => {
    const cap = novasCapturas();
    const resolver: Resolver = (c) => {
      if (c.table === "crm_leads" && c.terminal === "maybeSingle") {
        return {
          data: { id: LEAD, organization_id: ORG, pipeline_id: "p1", stage_id: STAGE, status: "open", contact_id: CONTATO },
          error: null,
        };
      }
      if (c.table === "crm_stages" && c.terminal === "maybeSingle") {
        return { data: { id: STAGE_PERDA, name: "Perdido" }, error: null };
      }
      return { data: c.terminal === "list" ? [] : null, error: null };
    };
    await crmCloseDemand.handler(
      { lead_id: LEAD, outcome: "lost", reason: "sem orçamento" },
      ctxDe(resolver, cap),
    );
    const reason = String(
      cap.inserts.find((i) => i.table === "crm_lead_activities")?.values.reason,
    );
    expect(semRedundancia(ACTIVITY_LABELS.demand_closed, reason)).toBe(true);
    expect(reason).toBe("Perdido — sem orçamento");
  });
});

describe("crm_list_at_risk_leads", () => {
  it("não vaza negócio de outra organização — toda leitura filtra a org do contexto", async () => {
    const cap = novasCapturas();
    const filtros: Array<Record<string, unknown>> = [];
    // Um lead COM dono-agente, estágio e contato: sem ele o radar retorna cedo e
    // só duas das sete leituras chegam a acontecer. Medido nesta sessão — o teste
    // anterior dizia "toda leitura" exercitando uma, e remover o filtro de org da
    // leitura de `demandas` mantinha os 23 verdes. Cobrir uma consulta dá álibi
    // às irmãs: a garantia é POR CONSULTA, não por função.
    const espiao: Resolver = (c) => {
      filtros.push({ table: c.table, ...c.filtros });
      if(c.table==="organizations") return {data:{settings:{}},error:null};
      if (c.table !== "crm_leads") return { data: [], error: null };
      return {
        data: [
          {
            id: LEAD,
            title: "Negócio",
            contact_id: CONTATO,
            owner_user_id: null,
            owner_kind: "ai_agent",
            owner_agent_id: "agente-1",
            stage_id: STAGE,
            last_activity_at: "2026-01-01T00:00:00Z",
            created_at: "2026-01-01T00:00:00Z",
            pipeline_id: "pipe-1",
          },
        ],
        error: null,
      };
    };

    await crmListAtRiskLeads.handler({ limit: 50, min_hours: undefined }, ctxDe(espiao, cap));

    // Service role bypassa RLS: a única defesa é o filtro explícito.
    const tabelas = filtros.map((f) => f.table);
    for (const esperada of [
      "crm_leads",
      "ai_agents",
      "crm_stages",
      "cron_jobs",
      "conversations",
      "contacts",
      "demandas",
      "organizations",
      "calendar_appointments",
    ]) {
      // Guarda de vacuidade por tabela: uma leitura que deixe de acontecer não
      // pode passar como "leitura sem vazamento".
      expect(tabelas, `o radar não leu "${esperada}"`).toContain(esperada);
    }
    for (const leitura of filtros) {
      expect(leitura.table === "organizations" ? leitura.id : leitura.organization_id, `leitura de "${leitura.table}" sem filtro de org`).toBe(ORG);
    }
  });

  it("entrega ao modelo as demandas abertas sem próximo passo", async () => {
    const cap = novasCapturas();
    const resolver: Resolver = (c) => {
      if (c.table !== "demandas") return { data: [], error: null };
      return {
        data: [
          {
            id: "d-1",
            contact_id: CONTATO,
            aberta_em: "2026-08-01T00:00:00Z",
            origem: "inbound",
            // O PostgREST devolve o join como ARRAY mesmo em relação
            // um-para-um. Se o código tratasse só o caso objeto, o nome do
            // contato viria nulo e a lista chegaria ao agente sem quem é.
            contacts: [{ display_name: "Cliente Um" }],
          },
        ],
        error: null,
      };
    };

    const r = (await crmListAtRiskLeads.handler(
      { limit: 50, min_hours: undefined },
      ctxDe(resolver, cap),
    )) as { sem_proximo_passo: Array<Record<string, unknown>>; total_sem_proximo_passo: number };

    expect(r.total_sem_proximo_passo).toBe(1);
    expect(r.sem_proximo_passo[0]?.contact_id).toBe(CONTATO);
    expect(r.sem_proximo_passo[0]?.contact_name).toBe("Cliente Um");
  });

  it("a promessa chega ao MODELO — a ponte monta a descrição do handler", () => {
    // O teste acima guarda a DEFINIÇÃO; este guarda o CALL SITE. Não é zelo
    // excessivo: medido nesta sessão, `description` também existe em
    // `lib/mcp/tools/catalogo/*.ts` — 48 das 51 divergem da do handler — e o
    // cabeçalho daquele arquivo diz textualmente "description fala com o
    // modelo". Ninguém lê aquele campo. Sem este teste, alguém "conserta" o
    // agente editando o arquivo errado e nada reprova.
    const ctx = {
      organizationId: ORG,
      role: "ai_operator",
      actor: { type: "ai_agent", id: "agente-1", role: "ai_operator" },
      apiTokenId: "tok-1",
      requestId: "run-1",
      supabase: {} as never,
    } as unknown as McpContext;
    const auth = {
      organizationId: ORG,
      role: "ai_operator",
      actor: ctx.actor,
      apiTokenId: "tok-1",
      scopes: ["mcp:read", "mcp:write", "actor:ai_agent", "role:ai_operator"],
    } as unknown as McpAuthResult;

    const montadas = pickToolsFromMcp({
      supabase: ctx.supabase,
      ctx,
      auth,
      toolIds: [crmListAtRiskLeads.name],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
    });

    const montada = montadas[crmListAtRiskLeads.name];
    expect(montada, "a capacidade não foi montada no turno").toBeDefined();
    expect(montada?.description).toBe(crmListAtRiskLeads.description);
    // E a promessa específica sobreviveu à travessia — não basta ser "alguma"
    // descrição.
    expect(montada?.description).toContain("sem_proximo_passo");
  });

  it("a descrição só promete campo que o payload realmente entrega", async () => {
    // Descrição é texto: passa no typecheck e no lint prometendo o que não
    // existe, e o modelo age sobre a promessa. Este teste liga as duas pontas —
    // remover o campo do payload OU inventar campo na descrição reprova.
    const cap = novasCapturas();
    const r = (await crmListAtRiskLeads.handler(
      { limit: 50, min_hours: undefined },
      ctxDe(() => ({ data: [], error: null }), cap),
    )) as Record<string, unknown>;

    const prometidos = [...crmListAtRiskLeads.description.matchAll(/`([a-z_]+)`/g)].map(
      (m) => m[1] as string,
    );
    const doPayload = new Set(Object.keys(r));
    const camposDeTopo = prometidos.filter((p) => !p.startsWith("crm_"));

    expect(camposDeTopo.length).toBeGreaterThan(0); // guarda de vacuidade
    for (const campo of camposDeTopo) {
      expect(doPayload.has(campo), `a descrição promete \`${campo}\`, que o payload não tem`).toBe(
        true,
      );
    }
  });
});
