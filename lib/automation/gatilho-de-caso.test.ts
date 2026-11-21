// @vitest-environment node
/**
 * O CASO DA CENTRAL COMO GATILHO de automação (#4900).
 *
 * O cliente usa DOIS funis: vendas e atendimento. As etapas do meio do funil de
 * atendimento ("Em atendimento", "Aguardando cliente", "Travado") são decididas
 * pelo CASO, não pelo passo do agente — e a ponte que existe hoje
 * (`crm_stages.agent_stage_hint`, os sete passos fixos de
 * `lib/agent-engine/agent/lead-state.ts`) é de mão única e serve ao funil de
 * vendas. Medido na instalação de quem abriu a issue: 11 cards abertos no funil
 * de atendimento, TODOS na primeira etapa, com caso aberto em um deles.
 *
 * Três blocos:
 *
 *   1. CATÁLOGO — os dois gatilhos estão na fonte única
 *      (`ENTIDADE_ESPERADA_POR_GATILHO`), dizem que a entidade é `agent_case`,
 *      DECLARAM o payload de que a ação precisa, e o handler do motor assina os
 *      eventos que o barramento realmente publica (`ai.case_*`).
 *   2. MOTOR — o evento real que o trigger do banco grava
 *      (`fn_emit_agent_case_event`, migration 0148) move o card para a etapa
 *      declarada pela regra, pelo executor de verdade (`create_or_move_lead`).
 *   3. CONTROLES — o mesmo evento duas vezes move UMA vez (idempotência), o card
 *      de VENDAS não é arrastado para o atendimento, o payload sem contato não
 *      move nada, e nenhuma automação antiga passa a disparar por engano.
 *
 * Só o TRANSPORTE é dublado: os dois handlers de `/api/v1/leads` (que têm a
 * régua de campos obrigatórios, o financeiro do fecho e o `emit_event`), a
 * origem de serviço e o audit. O que se mede é a DECISÃO — que etapa, com que
 * contato, quantas vezes —, que é onde mora o defeito desta issue.
 *
 * SABOTAGEM: apagar a chave `case_closed` de `ENTIDADE_ESPERADA_POR_GATILHO`
 * deixa o bloco 1 vermelho e o motor deixa de casar a regra (o `trigger_event`
 * da regra some do enum do schema), provando que o caminho do teste passa pelo
 * catálogo e não por uma lista paralela.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Linha = Record<string, unknown>;

const chamadas = vi.hoisted(() => ({ criados: [] as Linha[], movidos: [] as Linha[] }));
const estado = vi.hoisted(() => ({ banco: {} as Record<string, Linha[]> }));

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/atendimento/origem-automacao", () => ({
  originFromAutomationEvent: async () => null,
  serviceForAutomation: async () => null,
}));
/**
 * A FRONTEIRA dos handlers core de `/api/v1/leads`, e só ela: o dublê escreve
 * na tabela falsa exatamente o que o handler real escreveria (nasce `open` e na
 * etapa pedida; mover troca `stage_id` e `updated_at`) e ANOTA a chamada. É o
 * que permite contar quantas vezes o card foi escrito — a idempotência se prova
 * no contador, não no texto do retorno.
 */
vi.mock("@/app/api/v1/leads/_handler", () => ({
  createLeadHandler: async (_admin: unknown, ctx: { organization_id: string }, payload: Linha) => {
    const tabela = (estado.banco.crm_leads ??= []);
    const linha: Linha = {
      id: `lead-${tabela.length + 1}`,
      organization_id: ctx.organization_id,
      status: "open",
      created_at: new Date().toISOString(),
      position_in_stage: 1000,
      ...payload,
    };
    tabela.push(linha);
    chamadas.criados.push(payload);
    return { ...linha };
  },
  moveLeadHandler: async (_admin: unknown, _ctx: unknown, leadId: string, input: { to_stage_id: string }) => {
    const linha = (estado.banco.crm_leads ?? []).find((l) => l.id === leadId);
    if (!linha) throw new Error("lead não encontrado");
    Object.assign(linha, { stage_id: input.to_stage_id, updated_at: new Date().toISOString() });
    chamadas.movidos.push({ lead_id: leadId, ...input });
    return { ...linha };
  },
}));

import "@/lib/automation/actions/register-all";
import { getAction } from "@/lib/automation/actions";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { automationRulesHandler } from "@/lib/automation/engine.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  campoFaltandoNoPayload,
  ENTIDADE_ESPERADA_POR_GATILHO,
  eventoDoGatilho,
  EVENTOS_DOS_GATILHOS,
  gatilhoDoEvento,
  PAYLOAD_EXIGIDO_POR_GATILHO,
  TRIGGER_EVENTS,
  createAutomationRuleSchema,
} from "@/lib/schemas/webhooks";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const REGRA = "77777777-7777-4777-8777-7777777777b2";
const CASO = "99999999-9999-4999-8999-999999999999";
const CONVERSA = "conversa-do-caso";
/** O funil de ATENDIMENTO — o da issue. */
const FUNIL_ATENDIMENTO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** O funil de VENDAS — o card que NÃO pode ser arrastado. */
const FUNIL_VENDAS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA_NOVO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ETAPA_ATENDIMENTO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ETAPA_RESOLVIDO = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

type Filtro = { coluna: string; op: "eq" | "in" | "gt" | "gte"; valor: unknown };

function casa(linha: Linha, filtro: Filtro): boolean {
  const valor = linha[filtro.coluna];
  if (filtro.op === "eq") return valor === filtro.valor;
  if (filtro.op === "in") return (filtro.valor as unknown[]).includes(valor);
  return typeof valor === "string" && typeof filtro.valor === "string" && valor >= filtro.valor;
}

/** Dublê mínimo do PostgREST: o recorte que o motor e a ação usam. */
function bancoFalso(tabelas: Record<string, Linha[]>) {
  function consulta(tabela: string) {
    const filtros: Filtro[] = [];
    let limite: number | null = null;
    let inserindo: Linha | null = null;
    let atualizando: Linha | null = null;
    const guardadas = () => (tabelas[tabela] ??= []);
    const casadas = () => guardadas().filter((l) => filtros.every((f) => casa(l, f)));
    async function executar() {
      if (inserindo) {
        const linha = { id: `run-${guardadas().length + 1}`, created_at: new Date().toISOString(), ...inserindo };
        guardadas().push(linha);
        return { data: [linha], error: null };
      }
      if (atualizando) {
        for (const linha of casadas()) Object.assign(linha, atualizando);
        return { data: casadas(), error: null };
      }
      const linhas = casadas();
      return { data: limite === null ? linhas : linhas.slice(0, limite), error: null };
    }
    const q = {
      select: () => q,
      insert: (linha: Linha) => {
        inserindo = linha;
        return q;
      },
      upsert: (linha: Linha) => {
        inserindo = linha;
        return q;
      },
      update: (linha: Linha) => {
        atualizando = linha;
        return q;
      },
      order: () => q,
      limit: (n: number) => {
        limite = n;
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push({ coluna: c, op: "eq", valor: v });
        return q;
      },
      in: (c: string, v: unknown[]) => {
        filtros.push({ coluna: c, op: "in", valor: v });
        return q;
      },
      gt: (c: string, v: unknown) => {
        filtros.push({ coluna: c, op: "gt", valor: v });
        return q;
      },
      gte: (c: string, v: unknown) => {
        filtros.push({ coluna: c, op: "gte", valor: v });
        return q;
      },
      maybeSingle: async () => {
        const r = await executar();
        const linhas = (r.data ?? []) as Linha[];
        return { data: linhas[0] ?? null, error: null };
      },
      single: async () => {
        const r = await executar();
        const linhas = (r.data ?? []) as Linha[];
        return { data: linhas[0] ?? null, error: null };
      },
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) => executar().then(ok),
    };
    return q;
  }
  return { cliente: { from: consulta } as unknown as SupabaseClient, tabelas };
}

function contato(extra: Linha = {}): Linha {
  return {
    id: CONTATO,
    organization_id: ORG,
    name: "Maria da Silva",
    phone_number: "+552****9009",
    is_blocked: false,
    is_personal: false,
    ...extra,
  };
}

/** A regra que o operador monta: "caso fechado → leva o card para Resolvido". */
function regra(extra: Linha = {}): Linha {
  return {
    id: REGRA,
    organization_id: ORG,
    trigger_event: "case_closed",
    is_active: true,
    name: "Caso encerrado leva o card para Resolvido",
    conditions: [],
    actions: [
      {
        type: "create_or_move_lead",
        config: { pipeline_id: FUNIL_ATENDIMENTO, stage_id: ETAPA_RESOLVIDO },
      },
    ],
    trigger_config: {},
    ...extra,
  };
}

function mundo(opcoes: { contato?: Linha; regra?: Linha; leads?: Linha[] } = {}) {
  const b = bancoFalso({
    organizations: [{ id: ORG, locale: "pt-BR", timezone: "America/Sao_Paulo" }],
    contacts: [opcoes.contato ?? contato()],
    automation_rules: [opcoes.regra ?? regra()],
    automation_rule_runs: [],
    crm_leads: opcoes.leads ?? [],
    conversations: [{ id: CONVERSA, organization_id: ORG, contact_id: CONTATO }],
    agent_cases: [{ id: CASO, organization_id: ORG, conversation_id: CONVERSA, status: "resolved" }],
    calendar_appointments: [],
  });
  estado.banco = b.tabelas;
  return b;
}

let evento = 0;
/** O evento EXATO que `fn_emit_agent_case_event` grava (migration 0148). */
function eventoDeCaso(tipo: "ai.case_opened" | "ai.case_closed", payloadExtra: Linha = {}): EventRow {
  evento += 1;
  const status = tipo === "ai.case_opened" ? "awaiting_human" : "resolved";
  return {
    id: `00000000-0000-4000-8000-0000000001${String(evento).padStart(2, "0")}`,
    organization_id: ORG,
    event_type: tipo,
    entity_kind: "agent_case",
    entity_id: CASO,
    payload: {
      case_id: CASO,
      conversation_id: CONVERSA,
      contact_id: CONTATO,
      lead_id: null,
      agent_id: null,
      source: "agent",
      status,
      ...payloadExtra,
    },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

/** O card do funil de atendimento já criado, na etapa do meio do chamado. */
function cardDoAtendimento(extra: Linha = {}): Linha {
  return {
    id: "lead-do-atendimento",
    organization_id: ORG,
    contact_id: CONTATO,
    pipeline_id: FUNIL_ATENDIMENTO,
    stage_id: ETAPA_ATENDIMENTO,
    status: "open",
    title: "Maria da Silva",
    custom_fields: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...extra,
  };
}

beforeEach(() => {
  chamadas.criados.length = 0;
  chamadas.movidos.length = 0;
  estado.banco = {};
  evento = 0;
});

describe("catálogo: caso aberto e caso encerrado são gatilhos de primeira classe", () => {
  it("os dois estão na fonte única, com a entidade `agent_case`", () => {
    expect(TRIGGER_EVENTS).toContain("case_opened");
    expect(TRIGGER_EVENTS).toContain("case_closed");
    expect(ENTIDADE_ESPERADA_POR_GATILHO.case_opened).toBe("agent_case");
    expect(ENTIDADE_ESPERADA_POR_GATILHO.case_closed).toBe("agent_case");
  });

  it("o nome da regra e o evento do barramento são traduzidos nos DOIS sentidos", () => {
    // O barramento já fala `ai.case_*` (0148, com dois consumidores): renomear o
    // evento para caber na regra quebraria os dois. A tradução é a ponte.
    expect(eventoDoGatilho("case_opened")).toBe("ai.case_opened");
    expect(eventoDoGatilho("case_closed")).toBe("ai.case_closed");
    expect(gatilhoDoEvento("ai.case_opened")).toBe("case_opened");
    expect(gatilhoDoEvento("ai.case_closed")).toBe("case_closed");
    // E o caminho de sempre continua identidade — nada muda para os antigos.
    expect(eventoDoGatilho("lead.created")).toBe("lead.created");
    expect(gatilhoDoEvento("lead.created")).toBe("lead.created");
  });

  it("o handler do motor assina os eventos que o barramento publica", () => {
    // Assinar o nome da REGRA (`case_opened`) seria assinar um evento que
    // ninguém emite: a regra salvaria e nunca rodaria, em silêncio.
    expect(automationRulesHandler.events).toContain("ai.case_opened");
    expect(automationRulesHandler.events).toContain("ai.case_closed");
    expect(automationRulesHandler.events).not.toContain("case_opened");
    expect([...automationRulesHandler.events].sort()).toEqual([...EVENTOS_DOS_GATILHOS].sort());
  });

  it("cada gatilho de caso DECLARA o payload de que a ação precisa", () => {
    // A completude que a issue cobra: gatilho sem payload declarado é gatilho
    // que aceita entidade nenhuma e falha só na hora de mover o card.
    for (const gatilho of ["case_opened", "case_closed"] as const) {
      const exigidos = PAYLOAD_EXIGIDO_POR_GATILHO[gatilho];
      expect(exigidos, gatilho).toBeTruthy();
      expect(exigidos).toContain("contact_id");
      expect(exigidos).toContain("case_id");
      expect(exigidos).toContain("status");
    }
    // O payload real do emissor passa inteiro; sem o contato, ele é recusado e
    // o motor diz QUAL campo faltou.
    expect(campoFaltandoNoPayload("case_closed", eventoDeCaso("ai.case_closed").payload)).toBeNull();
    expect(campoFaltandoNoPayload("case_closed", { case_id: CASO, status: "resolved" })).toBe("contact_id");
    // Gatilho que não declara nada continua sem exigência nenhuma.
    expect(campoFaltandoNoPayload("lead.created", {})).toBeNull();
  });

  it("nenhuma automação ANTIGA passa a disparar por engano", () => {
    // A lista inteira, conferida uma a uma: só os dois de caso apontam para os
    // eventos de caso, e só eles são servidos por eles. Um gatilho antigo que
    // caísse aqui rodaria duas regras com o mesmo evento.
    for (const gatilho of TRIGGER_EVENTS) {
      if (gatilho === "case_opened" || gatilho === "case_closed") continue;
      expect(eventoDoGatilho(gatilho), gatilho).toBe(gatilho);
      expect(ENTIDADE_ESPERADA_POR_GATILHO[gatilho], gatilho).not.toBe("agent_case");
    }
    expect(gatilhoDoEvento("ai.case_updated")).toBe("ai.case_updated");
  });

  it("o schema da regra aceita o gatilho com a ação que já existe", () => {
    const resultado = createAutomationRuleSchema.safeParse({
      name: "Caso encerrado → Resolvido",
      trigger_event: "case_closed",
      conditions: [],
      actions: [
        {
          type: "create_or_move_lead",
          config: { pipeline_id: FUNIL_ATENDIMENTO, stage_id: ETAPA_RESOLVIDO },
        },
      ],
    });
    expect(resultado.success, JSON.stringify(resultado.error?.issues)).toBe(true);
    expect(getAction("create_or_move_lead")).toBeTruthy();
  });
});

describe("motor: o caso move o card do funil de atendimento", () => {
  it("caso ABERTO cria o card na etapa que a regra declara", async () => {
    const { cliente } = mundo({
      regra: regra({
        trigger_event: "case_opened",
        actions: [
          {
            type: "create_or_move_lead",
            config: { pipeline_id: FUNIL_ATENDIMENTO, stage_id: ETAPA_NOVO },
          },
        ],
      }),
    });

    const resultado = await runAutomationForEvent(cliente, eventoDeCaso("ai.case_opened"));

    expect(resultado.status).toBe("ok");
    expect(chamadas.criados).toHaveLength(1);
    expect(chamadas.criados[0]).toMatchObject({
      pipeline_id: FUNIL_ATENDIMENTO,
      stage_id: ETAPA_NOVO,
      contact_id: CONTATO,
    });
  });

  it("caso ENCERRADO move o card para a etapa declarada", async () => {
    const { cliente, tabelas } = mundo({ leads: [cardDoAtendimento()] });

    const resultado = await runAutomationForEvent(cliente, eventoDeCaso("ai.case_closed"));

    expect(resultado.status).toBe("ok");
    expect(chamadas.movidos).toHaveLength(1);
    expect(chamadas.movidos[0]).toMatchObject({
      lead_id: "lead-do-atendimento",
      to_stage_id: ETAPA_RESOLVIDO,
    });
    expect((tabelas.crm_leads ?? [])[0]?.stage_id).toBe(ETAPA_RESOLVIDO);
    expect(chamadas.criados).toHaveLength(0);
  });

  it("IDEMPOTÊNCIA: o mesmo evento entregue duas vezes move o card UMA vez", async () => {
    const { cliente, tabelas } = mundo({ leads: [cardDoAtendimento()] });
    const ev = eventoDeCaso("ai.case_closed");

    const primeira = await runAutomationForEvent(cliente, ev);
    const depoisDaPrimeira = (tabelas.crm_leads ?? [])[0]?.updated_at;
    const segunda = await runAutomationForEvent(cliente, ev);

    expect(primeira.status).toBe("ok");
    expect(segunda.status).toBe("ok");
    // A SEGUNDA entrega é um no-op declarado: o card já está na etapa, e
    // `moveLeadHandler` não é no-op na mesma etapa (reescreve `updated_at`,
    // reordena e emite `lead.stage_changed`).
    expect(chamadas.movidos).toHaveLength(1);
    // A ÚLTIMA linha de execução é a da segunda entrega — é ela que precisa
    // dizer "já estava lá", e não a da primeira.
    const runs = (tabelas.automation_rule_runs ?? []).filter((r) => r.rule_id === REGRA);
    expect(runs).toHaveLength(2);
    const run = runs.at(-1);
    expect((run?.actions_result as Linha[] | undefined)?.[0]).toMatchObject({
      type: "create_or_move_lead",
      status: "success",
      detail: { ja_na_etapa: "lead-do-atendimento" },
    });
    expect((tabelas.crm_leads ?? [])[0]?.updated_at).toBe(depoisDaPrimeira);
    expect((tabelas.crm_leads ?? [])[0]?.stage_id).toBe(ETAPA_RESOLVIDO);
  });

  it("CONTROLE: o card de VENDAS do mesmo contato NÃO é arrastado para o atendimento", async () => {
    // O contato tem card aberto em Vendas e abre um caso. Sem o recorte do
    // caso, a ação transferiria (clonando e encerrando a origem) o card de
    // vendas para o funil de atendimento — o board de quem vende esvaziaria a
    // cada caso.
    const venda = cardDoAtendimento({
      id: "lead-da-venda",
      pipeline_id: FUNIL_VENDAS,
      stage_id: "st-venda",
      title: "Proposta da Maria",
    });
    const { tabelas } = mundo({
      leads: [venda],
      regra: regra({
        trigger_event: "case_opened",
        actions: [
          {
            type: "create_or_move_lead",
            config: { pipeline_id: FUNIL_ATENDIMENTO, stage_id: ETAPA_NOVO },
          },
        ],
      }),
    });

    await runAutomationForEvent(clienteDe(tabelas), eventoDeCaso("ai.case_opened"));

    // O card de vendas fica exatamente onde estava...
    const cardDeVendas = (tabelas.crm_leads ?? []).find((l) => l.id === "lead-da-venda");
    expect(cardDeVendas).toMatchObject({ pipeline_id: FUNIL_VENDAS, stage_id: "st-venda", status: "open" });
    // ...e nasce um card NOVO no funil de atendimento.
    expect(chamadas.criados).toHaveLength(1);
    expect(chamadas.criados[0]).toMatchObject({ pipeline_id: FUNIL_ATENDIMENTO, stage_id: ETAPA_NOVO });
    expect(chamadas.movidos).toHaveLength(0);
  });

  it("CONTROLE: payload sem contato não move card nenhum, e DIZ o que faltou", async () => {
    const { cliente, tabelas } = mundo({ leads: [cardDoAtendimento()] });

    const resultado = await runAutomationForEvent(
      cliente,
      eventoDeCaso("ai.case_closed", { contact_id: "" }),
    );

    expect(resultado).toMatchObject({ status: "skipped", detail: "payload_incompleto:contact_id" });
    expect(chamadas.movidos).toHaveLength(0);
    expect(tabelas.automation_rule_runs ?? []).toHaveLength(0);
  });

  it("CONTROLE: evento de caso com a entidade errada continua sendo recusado", async () => {
    const { cliente } = mundo({ leads: [cardDoAtendimento()] });
    const ev = { ...eventoDeCaso("ai.case_closed"), entity_kind: "crm_lead" };

    const resultado = await runAutomationForEvent(cliente, ev);

    expect(resultado).toMatchObject({ status: "skipped", detail: "entity_kind_mismatch" });
    expect(chamadas.movidos).toHaveLength(0);
  });
});

/** O cliente falso sobre as MESMAS tabelas — para quem montou o mundo e guardou só elas. */
function clienteDe(tabelas: Record<string, Linha[]>): SupabaseClient {
  return bancoFalso(tabelas).cliente;
}
