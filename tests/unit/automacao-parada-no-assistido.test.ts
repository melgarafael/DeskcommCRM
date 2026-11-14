// @vitest-environment node
/**
 * Doc 301 = B: no modo ASSISTIDO, quando quem mexe é a IA, a automação não fala
 * com o cliente sozinha (`lib/automation/parada-no-assistido.ts`).
 *
 * Uma regra com as cinco ações (etiqueta + as quatro que falam com o cliente)
 * roda contra o MESMO evento em três versões do metadata: IA no assistido, IA no
 * automático e pessoa. Só a primeira segura alguma coisa — e segura exatamente
 * as quatro da lista do doc, abrindo o aviso na Central com o run.
 *
 *     pnpm vitest run tests/unit/automacao-parada-no-assistido.test.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { registerAction } from "@/lib/automation/actions";
import { runAutomationForEvent } from "@/lib/automation/engine";
import {
  ACOES_QUE_FALAM_COM_O_CLIENTE,
  acaoFicaParada,
  escritaComMarca,
  marcaDoAssistido,
  marcaHerdadaDoEvento,
  MOTIVO_PARADA_NO_ASSISTIDO,
} from "@/lib/automation/parada-no-assistido";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const REGRA = "77777777-7777-4777-8777-7777777777a1";
const RUN = "88888888-8888-4888-8888-888888888801";

const executadas: string[] = [];
/** A janela do WhatsApp fechada: se a ação parada fosse consultada, o evento inteiro adiaria. */
let janelaFechada = false;

// `ai_decide` com o MESMO adiamento do de verdade (`actions/ai-decide.ts`): ele
// consulta as janelas das opções, então a janela fechada adia a decisão.
for (const tipo of ["add_tag", "ai_decide", ...ACOES_QUE_FALAM_COM_O_CLIENTE]) {
  registerAction({
    type: tipo,
    ...(tipo === "send_whatsapp_message" || tipo === "ai_decide"
      ? { postponeUntil: async () => (janelaFechada ? "2099-01-01T10:00:00.000Z" : null) }
      : {}),
    async execute() {
      executadas.push(tipo);
      return { type: tipo, status: "success" };
    },
  });
}

type Linha = Record<string, unknown>;
const inserts: Array<{ tabela: string; linha: Linha }> = [];

type Acao = { type: string; config: Record<string, unknown> };
const REGRA_PADRAO: Acao[] = ["add_tag", ...ACOES_QUE_FALAM_COM_O_CLIENTE].map((type) => ({ type, config: {} }));

function banco(acoes: Acao[] = REGRA_PADRAO): SupabaseClient {
  const tabelas: Record<string, Linha[]> = {
    crm_leads: [{ id: LEAD, organization_id: ORG, contact_id: null, source_metadata: {} }],
    automation_rules: [
      {
        id: REGRA,
        organization_id: ORG,
        trigger_event: "lead.stage_changed",
        is_active: true,
        name: "Proposta enviada",
        conditions: [],
        actions: acoes,
        trigger_config: {},
      },
    ],
  };
  function consulta(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    let inserido = false;
    const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
    const q = {
      select: () => q,
      insert: (linha: Linha) => {
        inserts.push({ tabela, linha });
        inserido = true;
        return q;
      },
      update: () => q,
      order: () => q,
      in: () => q,
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      maybeSingle: async () => ({ data: inserido ? { id: RUN } : (linhas()[0] ?? null), error: null }),
      then: (ok: (r: { data: Linha[]; error: null }) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(ok),
    };
    return q;
  }
  return { from: consulta } as unknown as SupabaseClient;
}

function cardMovido(metadata: Record<string, unknown>): EventRow {
  return {
    id: "evt-1",
    organization_id: ORG,
    event_type: "lead.stage_changed",
    entity_kind: "crm_lead",
    entity_id: LEAD,
    payload: { from_stage_id: "s1", to_stage_id: "s2" },
    metadata,
    consumed_by: [],
    attempts: 0,
  };
}

const IA_NO_ASSISTIDO = {
  actor_type: "ai_agent",
  actor_id: "ag-1",
  ...marcaDoAssistido({ type: "ai_agent", id: "ag-1", role: "ai_operator", operation_mode: "assisted" }),
};

function runGravado() {
  return inserts.find((i) => i.tabela === "automation_rule_runs")?.linha as
    | { status: string; actions_result: Array<{ type: string; status: string; error?: string }> }
    | undefined;
}
const avisos = () => inserts.filter((i) => i.tabela === "agent_inbox_items").map((i) => i.linha);

beforeEach(() => {
  executadas.length = 0;
  inserts.length = 0;
  janelaFechada = false;
});

describe("automação disparada pela IA no modo assistido (doc 301 = B)", () => {
  it("o emissor marca o evento só quando o ator é a IA no assistido", () => {
    expect(IA_NO_ASSISTIDO.actor_operation_mode).toBe("assisted");
    expect(marcaDoAssistido({ type: "ai_agent", id: "ag-1", role: "ai_operator" })).toEqual({});
    expect(marcaDoAssistido({ type: "user", id: "u-1" })).toEqual({});
  });

  it("segura as quatro que falam com o cliente, roda a etiqueta e abre o aviso com o run", async () => {
    const r = await runAutomationForEvent(banco(), cardMovido(IA_NO_ASSISTIDO));

    expect(r.status).toBe("ok");
    expect(executadas).toEqual(["add_tag"]);
    const run = runGravado()!;
    expect(run.status).toBe("partial");
    expect(run.actions_result.map((a) => [a.type, a.status, a.error ?? null])).toEqual([
      ["add_tag", "success", null],
      ...ACOES_QUE_FALAM_COM_O_CLIENTE.map((t) => [t, "skipped", MOTIVO_PARADA_NO_ASSISTIDO]),
    ]);
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0]).toMatchObject({
      organization_id: ORG,
      kind: "other",
      ref_kind: "automation_rule_run",
      ref_id: RUN,
    });
    expect(String(avisos()[0]!.body)).toContain("Proposta enviada");
  });

  it("a ação parada não adia o evento: a janela fechada do WhatsApp não segura a etiqueta", async () => {
    janelaFechada = true;
    const r = await runAutomationForEvent(banco(), cardMovido(IA_NO_ASSISTIDO));

    expect(r.status).toBe("ok");
    expect(executadas).toEqual(["add_tag"]);
  });

  it("no modo AUTOMÁTICO nada muda: as cinco rodam e nenhum aviso abre", async () => {
    const r = await runAutomationForEvent(banco(), cardMovido({ actor_type: "ai_agent", actor_id: "ag-1" }));

    expect(r.status).toBe("ok");
    expect(executadas).toEqual(["add_tag", ...ACOES_QUE_FALAM_COM_O_CLIENTE]);
    expect(runGravado()!.status).toBe("success");
    expect(avisos()).toEqual([]);
  });

  it("no automático a janela fechada continua adiando o evento inteiro, como antes", async () => {
    janelaFechada = true;
    const r = await runAutomationForEvent(banco(), cardMovido({ actor_type: "ai_agent", actor_id: "ag-1" }));

    expect(r.status).toBe("retry");
    expect(executadas).toEqual([]);
  });

  it("quando quem move é uma PESSOA, nada muda", async () => {
    await runAutomationForEvent(banco(), cardMovido({ actor_type: "user" }));

    expect(executadas).toEqual(["add_tag", ...ACOES_QUE_FALAM_COM_O_CLIENTE]);
    expect(avisos()).toEqual([]);
  });
});

/** Uma `ai_decide` cujas opções são as ações dadas (o formato de `acaoAlvoSchema`). */
function decisao(...tipos: string[]): Acao {
  return {
    type: "ai_decide",
    config: {
      instrucao: "decida",
      opcoes: tipos.map((t, i) => ({ id: `o${i}`, rotulo: t, acao: { type: t, config: {} } })),
    },
  };
}

describe("a ai_decide no modo assistido (doc 301 = B, achado 1 do cético)", () => {
  it("com uma opção que fala com o cliente, a decisão inteira fica parada e abre o aviso", async () => {
    await runAutomationForEvent(banco([{ type: "add_tag", config: {} }, decisao("add_tag", "send_whatsapp_message")]), cardMovido(IA_NO_ASSISTIDO));

    expect(executadas).toEqual(["add_tag"]);
    expect(runGravado()!.actions_result.map((a) => [a.type, a.error ?? null])).toEqual([
      ["add_tag", null],
      ["ai_decide", MOTIVO_PARADA_NO_ASSISTIDO],
    ]);
    expect(avisos()).toHaveLength(1);
    expect(String(avisos()[0]!.body)).toContain("decisão da IA");
  });

  it("a decisão parada não adia o evento pela janela das opções", async () => {
    janelaFechada = true;
    const r = await runAutomationForEvent(banco([{ type: "add_tag", config: {} }, decisao("send_whatsapp_message")]), cardMovido(IA_NO_ASSISTIDO));

    expect(r.status).toBe("ok");
    expect(executadas).toEqual(["add_tag"]);
  });

  it("CONTROLE: a decisão só entre ações internas roda no assistido", async () => {
    await runAutomationForEvent(banco([decisao("add_tag")]), cardMovido(IA_NO_ASSISTIDO));

    expect(executadas).toEqual(["ai_decide"]);
    expect(avisos()).toEqual([]);
  });

  it("CONTROLE: no automático a decisão com WhatsApp roda", async () => {
    await runAutomationForEvent(banco([decisao("send_whatsapp_message")]), cardMovido({ actor_type: "ai_agent", actor_id: "ag-1" }));

    expect(executadas).toEqual(["ai_decide"]);
  });

  it("acaoFicaParada lê as opções; config torta não segura nada", () => {
    const marcado = { metadata: IA_NO_ASSISTIDO };
    expect(acaoFicaParada(marcado, decisao("start_message_flow"))).toBe(true);
    expect(acaoFicaParada(marcado, decisao("add_tag"))).toBe(false);
    expect(acaoFicaParada(marcado, { type: "ai_decide", config: { opcoes: "x" } })).toBe(false);
    expect(acaoFicaParada({ metadata: {} }, decisao("send_email"))).toBe(false);
  });
});

describe("a marca passa adiante (doc 301 = B, achados 2 e a do cético)", () => {
  it("a regra que rodou por causa da IA no assistido herda a marca, e o ator dela a emite", () => {
    const herdada = marcaHerdadaDoEvento({ metadata: IA_NO_ASSISTIDO });
    expect(herdada).toEqual({ operation_mode: "assisted" });
    expect(marcaDoAssistido({ type: "webhook_source", id: "rule-1", ...herdada })).toEqual({ actor_operation_mode: "assisted" });
    expect(marcaHerdadaDoEvento({ metadata: { actor_type: "user" } })).toEqual({});
    expect(marcaDoAssistido({ type: "webhook_source", id: "rule-1" })).toEqual({});
  });

  it("a escrita do negócio leva o cabeçalho que o gatilho do banco lê — só no assistido", () => {
    const cabecalhos: Array<[string, string]> = [];
    interface Construtor { setHeader(n: string, v: string): Construtor }
    const builder: Construtor = { setHeader: (n, v) => (cabecalhos.push([n, v]), builder) };
    escritaComMarca(builder, { type: "ai_agent", id: "ag-1", role: "ai_operator", operation_mode: "assisted" });
    escritaComMarca(builder, { type: "webhook_source", id: "rule-1", operation_mode: "assisted" });
    escritaComMarca(builder, { type: "ai_agent", id: "ag-1", role: "ai_operator" });
    escritaComMarca(builder, { type: "user", id: "u-1" });
    expect(cabecalhos).toEqual([
      ["x-actor-operation-mode", "assisted"],
      ["x-actor-operation-mode", "assisted"],
    ]);
  });
});

describe("call_webhook no modo assistido (risco da 1.111.0)", () => {
  // O servidor externo pode falar com o cliente: no assistido, espera aprovação.
  registerAction({
    type: "call_webhook",
    async execute() {
      executadas.push("call_webhook");
      return { type: "call_webhook", status: "success" };
    },
  });

  it("a call_webhook fica parada e o aviso nomeia o webhook", async () => {
    await runAutomationForEvent(
      banco([{ type: "add_tag", config: {} }, { type: "call_webhook", config: {} }]),
      cardMovido(IA_NO_ASSISTIDO),
    );

    expect(executadas).toEqual(["add_tag"]);
    expect(runGravado()!.actions_result.map((a) => [a.type, a.error ?? null])).toEqual([
      ["add_tag", null],
      ["call_webhook", MOTIVO_PARADA_NO_ASSISTIDO],
    ]);
    expect(avisos()).toHaveLength(1);
    expect(String(avisos()[0]!.body)).toContain("Avisar outro sistema (webhook)");
  });

  it("a ai_decide que pode escolher call_webhook fica parada", async () => {
    expect(acaoFicaParada({ metadata: IA_NO_ASSISTIDO }, decisao("add_tag", "call_webhook"))).toBe(true);
    await runAutomationForEvent(banco([decisao("call_webhook")]), cardMovido(IA_NO_ASSISTIDO));
    expect(executadas).toEqual([]);
    expect(runGravado()!.actions_result.map((a) => a.error ?? null)).toEqual([MOTIVO_PARADA_NO_ASSISTIDO]);
  });

  it("CONTROLE: no automático e com pessoa a call_webhook roda", async () => {
    await runAutomationForEvent(banco([{ type: "call_webhook", config: {} }]), cardMovido({ actor_type: "ai_agent", actor_id: "ag-1" }));
    await runAutomationForEvent(banco([{ type: "call_webhook", config: {} }]), cardMovido({ actor_type: "user", actor_id: "u-1" }));
    expect(executadas).toEqual(["call_webhook", "call_webhook"]);
    expect(avisos()).toEqual([]);
  });
});
