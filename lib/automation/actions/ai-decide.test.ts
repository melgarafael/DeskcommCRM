/**
 * `ai_decide` (#1970) — a ação que decide e dispara.
 *
 * Três provas, na ordem dos critérios da issue:
 *
 *  1. SCHEMA: a ação é OPCIONAL (regra sem ela valida igual), o conjunto de
 *     opções é FINITO com UMA ação-alvo das fixas por opção, e o custo de token
 *     só entra com registro explícito.
 *  2. MOTOR: a escolha vira execução da ação-alvo — provado com a ação
 *     `add_tag` DE VERDADE (registrada no mesmo registro que o motor usa) e um
 *     admin fake, incluindo a linha gravada em `automation_rule_runs`.
 *  3. FALLBACK: resposta inválida NÃO executa nada e deixa o motivo no run.
 *
 * A chamada de modelo é mockada (`decisao-de-acao`): o que se testa aqui é o
 * contrato da ação — o modelo é SÓ a fonte da escolha, e escolha inválida é
 * recusa, nunca default. O parse da resposta é coberto junto, pelo mock
 * devolver exatamente o que um modelo devolveria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/agent/decisao-de-acao", () => ({ decidirAcao: vi.fn() }));
// A falha vira `failed` ⇒ o motor audita. Sem o mock o audit escapa para o
// banco de verdade (e para fora da suíte) no único caso em que ele roda.
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
// A ação-alvo `create_or_move_lead` de verdade, com o handler de mover no lugar
// do banco: o que a trava de laço precisa ver é o `requestId` que ele recebe.
vi.mock("@/app/api/v1/leads/_handler", () => ({
  moveLeadHandler: vi.fn(async (_sb: unknown, _ctx: unknown, id: string) => ({ id })),
  createLeadHandler: vi.fn(),
}));
vi.mock("@/lib/atendimento/origem-automacao", () => ({ originFromAutomationEvent: vi.fn(async () => null) }));

import { runAutomationForEvent } from "@/lib/automation/engine";
import { getAction } from "@/lib/automation/actions";
import type { ActionCtx } from "@/lib/automation/types";
import { decidirAcao } from "@/lib/agent-engine/agent/decisao-de-acao";
import { createAutomationRuleSchema } from "@/lib/schemas/webhooks";
import type { EventRow } from "@/lib/event-log/dispatcher";

import { moveLeadHandler } from "@/app/api/v1/leads/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

import "@/lib/automation/actions/add-tag";
import "@/lib/automation/actions/ai-decide";
import "@/lib/automation/actions/create-or-move-lead";

const decidir = vi.mocked(decidirAcao);
const mover = vi.mocked(moveLeadHandler);

const ORG = "11111111-1111-4111-8111-111111111111";
const REGRA = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

/** O `ai_decide` gravável — o mesmo objeto do schema e do motor. */
const AI_DECIDE = {
  type: "ai_decide",
  config: {
    custo_de_token: true,
    instrucao: "Se demonstrou interesse em parcelamento, marque como quente; do contrário, agende o retorno.",
    opcoes: [
      {
        id: "quente",
        rotulo: "Marcar como quente",
        acao: { type: "add_tag", config: { tags: ["quente"] } },
      },
      {
        id: "retorno",
        rotulo: "Criar tarefa de retorno",
        acao: {
          type: "create_task",
          config: { titulo: "Retorno: {{contact.name}}", vence_em_dias: 2, atribuir_a: "dono_do_lead", prioridade: "high" },
        },
      },
    ],
  },
};

const ADD_TAG = { type: "add_tag", config: { tags: ["avaliando"] } };

function regra(actions: unknown[], triggerEvent = "message.received") {
  return { name: "Regra de teste", trigger_event: triggerEvent, conditions: [], actions };
}

function ctx(context: Record<string, unknown>, admin?: ActionCtx["admin"]): ActionCtx {
  return {
    admin: admin ?? ({} as ActionCtx["admin"]),
    organizationId: ORG,
    ruleId: REGRA,
    ruleName: "Regra de teste",
    requestId: "evt-1",
    event: evento(),
    context,
  };
}

function evento(): EventRow {
  return {
    id: "evt-1",
    organization_id: ORG,
    event_type: "lead.created",
    entity_kind: "crm_lead",
    entity_id: LEAD,
    payload: {},
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

interface AdminFake {
  admin: ActionCtx["admin"];
  inserts: Array<{ table: string; data: Record<string, unknown> }>;
  updates: Array<{ table: string; data: Record<string, unknown> }>;
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
}

/**
 * O tradutor de query builder do harness de invariantes, no miolo que o motor
 * usa: `.select/.insert/.update + .eq/.order` e `.maybeSingle`, resolvidos por
 * TABELA e MODO. Registra inserts/updates/rpc para as asserções — o que prova
 * que `add_tag` rodou é o `emit_event`, não um mock dela.
 */
function adminFake(opcoes: { rules?: unknown[]; lead?: Record<string, unknown> | null } = {}): AdminFake {
  const registro: AdminFake = { admin: null as unknown as ActionCtx["admin"], inserts: [], updates: [], rpcs: [] };

  const listar = (table: string, mode: string, data: Record<string, unknown> | null) => {
    if (table === "automation_rules" && mode === "select") return { data: opcoes.rules ?? [], error: null };
    if (mode === "insert") {
      registro.inserts.push({ table, data: data ?? {} });
      return { error: null };
    }
    if (mode === "update") {
      registro.updates.push({ table, data: data ?? {} });
      return { error: null };
    }
    return { data: [], error: null };
  };

  const unico = (table: string, mode: string, data: Record<string, unknown> | null) => {
    if (table === "automation_rule_runs" && mode === "insert") {
      registro.inserts.push({ table, data: data ?? {} });
      return { data: { id: "run-1" }, error: null };
    }
    if (table === "automation_rules" && mode === "select") return { data: { run_count: 7 }, error: null };
    if (table === "crm_leads" && mode === "select") return { data: opcoes.lead ?? null, error: null };
    return { data: null, error: null };
  };

  registro.admin = {
    from(table: string) {
      let mode: "select" | "insert" | "update" = "select";
      let payload: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.insert = (d: Record<string, unknown>) => {
        mode = "insert";
        payload = d;
        return builder;
      };
      builder.update = (d: Record<string, unknown>) => {
        mode = "update";
        payload = d;
        return builder;
      };
      builder.eq = () => builder;
      builder.order = () => builder;
      builder.maybeSingle = async () => unico(table, mode, payload);
      builder.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
        Promise.resolve(listar(table, mode, payload)).then(onF, onR);
      return builder;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      registro.rpcs.push({ fn, args });
      return { data: null, error: null };
    },
  } as unknown as ActionCtx["admin"];

  return registro;
}

const executor = () => getAction("ai_decide")!;

const LEAD_HIDRATADO = { id: LEAD, contact_id: null, tags: [] as string[] };

beforeEach(() => {
  decidir.mockReset();
  mover.mockClear();
});

describe("schema: ai_decide é opcional e declarado", () => {
  it("regra SEM ai_decide continua passando igual — a ação nova não muda o que já existia", () => {
    const semIa = createAutomationRuleSchema.safeParse(regra([ADD_TAG]));
    expect(semIa.success).toBe(true);

    // …e a mesma regra com a ação nova no meio também passa: as fixas seguem
    // válidas lado a lado com a de decisão (convivência por org, da issue).
    const comIa = createAutomationRuleSchema.safeParse(regra([ADD_TAG, AI_DECIDE]));
    expect(comIa.success).toBe(true);
  });

  it("custo de token só entra com registro EXPLÍCITO no schema", () => {
    const semRegistro = structuredClone(AI_DECIDE);
    delete (semRegistro.config as Record<string, unknown>).custo_de_token;
    expect(createAutomationRuleSchema.safeParse(regra([semRegistro])).success).toBe(false);

    const registroFalso = structuredClone(AI_DECIDE);
    (registroFalso.config as Record<string, unknown>).custo_de_token = false;
    expect(createAutomationRuleSchema.safeParse(regra([registroFalso])).success).toBe(false);

    expect(createAutomationRuleSchema.safeParse(regra([AI_DECIDE])).success).toBe(true);
  });

  it("conjunto FINITO: de 2 a 6 opções, id único e UMA ação-alvo das fixas por opção", () => {
    const comOpcoes = (opcoes: unknown[]) => {
      const acao = structuredClone(AI_DECIDE);
      (acao.config as Record<string, unknown>).opcoes = opcoes;
      return createAutomationRuleSchema.safeParse(regra([acao])).success;
    };
    const uma = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `op-${i}`,
        rotulo: `Opção ${i}`,
        acao: { type: "add_tag", config: { tags: ["x"] } },
      }));

    expect(comOpcoes(uma(1)), "uma opção não é decisão").toBe(false);
    expect(comOpcoes(uma(6))).toBe(true);
    expect(comOpcoes(uma(7)), "conjunto tem que ser finito").toBe(false);

    const duplicada = [
      ...uma(2).slice(0, 1),
      { id: "op-0", rotulo: "Outra com o mesmo id", acao: { type: "add_tag", config: { tags: ["y"] } } },
    ];
    expect(comOpcoes(duplicada), "id repetido executaria a opção errada").toBe(false);

    const alvoDesconhecido = [
      ...uma(1),
      { id: "op-x", rotulo: "Ação inexistente", acao: { type: "explodir_tudo", config: {} } },
    ];
    expect(comOpcoes(alvoDesconhecido), "só ação que o motor já conhece").toBe(false);

    const alvoRecursivo = [
      ...uma(1),
      { id: "op-y", rotulo: "Decidir de novo", acao: { type: "ai_decide", config: AI_DECIDE.config } },
    ];
    expect(comOpcoes(alvoRecursivo), "ai_decide não pode escolher a si mesma").toBe(false);
  });
});

describe("execução: a escolha vira a ação-alvo", () => {
  it("escolha válida dispara a ação-alvo da opção (add_tag de verdade, pelo registro)", async () => {
    decidir.mockResolvedValue({ ok: true, escolha: "quente" });
    const fake = adminFake({ lead: { id: LEAD, contact_id: null, tags: [] } });

    const resultado = await executor().execute(ctx({ lead: { id: LEAD, contact_id: null, tags: [] } }, fake.admin), AI_DECIDE.config);

    expect(resultado.type).toBe("ai_decide");
    expect(resultado.status).toBe("success");
    expect(resultado.detail).toMatchObject({ escolha: "quente", acao_alvo: "add_tag", added: ["quente"] });
    // A prova de que a ação-alvo RODOU: o update no lead e o evento emitido.
    expect(fake.updates.some((u) => u.table === "crm_leads" && (u.data.tags as string[]).includes("quente"))).toBe(true);
    expect(fake.rpcs.some((r) => r.fn === "emit_event")).toBe(true);
  });

  it("resposta INVÁLIDA não executa nada e registra o motivo", async () => {
    decidir.mockResolvedValue({ ok: false, motivo: "escolha_fora_do_conjunto" });
    const fake = adminFake({ lead: { id: LEAD, contact_id: null, tags: [] } });

    const resultado = await executor().execute(ctx({ lead: { id: LEAD, contact_id: null, tags: [] } }, fake.admin), AI_DECIDE.config);

    expect(resultado).toEqual({
      type: "ai_decide",
      status: "failed",
      error: "escolha_fora_do_conjunto",
      detail: { reason: "escolha_fora_do_conjunto" },
    });
    expect(fake.updates).toEqual([]);
    expect(fake.rpcs).toEqual([]);
  });

  it("resposta ilegível (prosa sem JSON) também não executa nada", async () => {
    // É o que um modelo fora do formato devolve de verdade — e por isso o
    // motivo é `sem_json`, não "falha genérica": o run tem que dizer o PORQUÊ.
    decidir.mockResolvedValue({ ok: false, motivo: "sem_json" });
    const fake = adminFake({ lead: { id: LEAD, contact_id: null, tags: [] } });

    const resultado = await executor().execute(ctx({ lead: { id: LEAD, contact_id: null, tags: [] } }, fake.admin), AI_DECIDE.config);

    expect(resultado.status).toBe("failed");
    expect(resultado.detail).toEqual({ reason: "sem_json" });
    expect(fake.rpcs).toEqual([]);
  });

  it("erro do modelo (orçamento, provedor) não executa nada e leva a causa ao run", async () => {
    decidir.mockRejectedValue(new Error("orçamento mensal de IA da organização atingido"));
    const fake = adminFake({ lead: { id: LEAD, contact_id: null, tags: [] } });

    const resultado = await executor().execute(ctx({ lead: { id: LEAD, contact_id: null, tags: [] } }, fake.admin), AI_DECIDE.config);

    expect(resultado.status).toBe("failed");
    expect(resultado.error).toContain("orçamento mensal");
    expect(fake.rpcs).toEqual([]);
  });

  it("sem o registro do custo de token, a IA nem é perguntada", async () => {
    const semCusto = structuredClone(AI_DECIDE);
    delete (semCusto.config as Record<string, unknown>).custo_de_token;

    const resultado = await executor().execute(ctx({ lead: { id: LEAD, contact_id: null, tags: [] } }), semCusto.config);

    expect(resultado).toEqual({
      type: "ai_decide",
      status: "skipped",
      detail: { reason: "custo_de_token_nao_registrado" },
    });
    expect(decidir).not.toHaveBeenCalled();
  });
});

describe("motor: runAutomationForEvent", () => {
  it("executa a escolha e grava o run com a escolha e a ação-alvo", async () => {
    decidir.mockResolvedValue({ ok: true, escolha: "quente" });
    const fake = adminFake({ rules: [{ id: REGRA, name: "Regra de teste", conditions: [], actions: [AI_DECIDE] }], lead: LEAD_HIDRATADO });

    const resultado = await runAutomationForEvent(fake.admin, evento());

    expect(resultado.status).toBe("ok");
    const run = fake.inserts.find((i) => i.table === "automation_rule_runs");
    expect(run, "o run não foi gravado").toBeDefined();
    expect(run!.data.status).toBe("success");
    expect((run!.data.actions_result as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "ai_decide",
      status: "success",
      detail: { escolha: "quente", acao_alvo: "add_tag" },
    });
    expect(fake.rpcs.some((r) => r.fn === "emit_event"), "a ação-alvo não executou").toBe(true);
  });

  it("regra SEM ai_decide roda igual no motor — o resultado é o da ação fixa, sem passe nenhum", async () => {
    const fake = adminFake({ rules: [{ id: REGRA, name: "Regra de teste", conditions: [], actions: [ADD_TAG] }], lead: LEAD_HIDRATADO });

    const resultado = await runAutomationForEvent(fake.admin, evento());

    expect(resultado.status).toBe("ok");
    const run = fake.inserts.find((i) => i.table === "automation_rule_runs");
    expect(run!.data.status).toBe("success");
    expect((run!.data.actions_result as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "add_tag",
      status: "success",
    });
    expect(decidir, "regra fixa não pode chamar a IA").not.toHaveBeenCalled();
    expect(fake.rpcs.some((r) => r.fn === "emit_event")).toBe(true);
  });

  it("escolha inválida no motor: nada executa e o run guarda o motivo", async () => {
    decidir.mockResolvedValue({ ok: false, motivo: "escolha_fora_do_conjunto" });
    const fake = adminFake({ rules: [{ id: REGRA, name: "Regra de teste", conditions: [], actions: [AI_DECIDE] }], lead: LEAD_HIDRATADO });

    const resultado = await runAutomationForEvent(fake.admin, evento());

    expect(resultado.status).toBe("ok"); // o consumidor processou; a REGRA é que falhou
    const run = fake.inserts.find((i) => i.table === "automation_rule_runs");
    expect(run!.data.status).toBe("failed");
    expect((run!.data.actions_result as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "ai_decide",
      status: "failed",
      detail: { reason: "escolha_fora_do_conjunto" },
    });
    // O motor atualiza `automation_rules` (run_count) sempre; o que não pode
    // existir é o update da ação-alvo no LEAD.
    expect(fake.updates.filter((u) => u.table === "crm_leads"), "a ação-alvo não pode ter rodado").toEqual([]);
    expect(fake.rpcs).toEqual([]);
  });
});

describe("trava contra laço infinito pelo passo novo (#1528)", () => {
  const FUNIL = "44444444-4444-4444-8444-444444444444";
  const ETAPA = "55555555-5555-4555-8555-555555555555";
  /** A IA pode escolher MOVER o negócio — a opção que fecharia o laço. */
  const AI_DECIDE_MOVE = {
    type: "ai_decide",
    config: {
      custo_de_token: true,
      instrucao: "Se quer parcelar, leva para Negociação; senão, etiqueta.",
      opcoes: [
        { id: "mover", rotulo: "Levar para Negociação", acao: { type: "create_or_move_lead", config: { pipeline_id: FUNIL, stage_id: ETAPA } } },
        { id: "etiquetar", rotulo: "Etiquetar", acao: { type: "add_tag", config: { tags: ["esperando"] } } },
      ],
    },
  };
  const LEAD_NO_FUNIL = { id: LEAD, contact_id: null, pipeline_id: FUNIL, stage_id: "outra", tags: [] as string[] };
  const eventoDeLead = (eventType: string, metadata: Record<string, unknown> = {}): EventRow => ({
    ...evento(),
    event_type: eventType,
    metadata,
  });

  it("negócio movido → a IA move: o movimento volta marcado e o motor NÃO roda a regra de novo", async () => {
    decidir.mockResolvedValue({ ok: true, escolha: "mover" });
    const regras = [{ id: REGRA, name: "Regra de teste", conditions: [], actions: [AI_DECIDE_MOVE] }];

    const primeira = adminFake({ rules: regras, lead: LEAD_NO_FUNIL });
    await runAutomationForEvent(primeira.admin, eventoDeLead("lead.stage_changed"));

    expect(mover, "a ação-alvo escolhida tem que ter movido o negócio").toHaveBeenCalledTimes(1);
    const requestId = (mover.mock.calls[0]![1] as HandlerCtx).requestId;
    expect(requestId).toBe(`rule:${REGRA}`);

    // O `lead.stage_changed` que o mover emite carrega esse request_id em
    // `metadata` (app/api/v1/leads/_handler.ts). Ele volta ao motor:
    const segunda = adminFake({ rules: regras, lead: LEAD_NO_FUNIL });
    const volta = await runAutomationForEvent(segunda.admin, eventoDeLead("lead.stage_changed", { request_id: requestId }));

    expect(volta).toMatchObject({ status: "skipped", detail: "caused_by_rule" });
    expect(decidir, "a volta não pode perguntar à IA de novo").toHaveBeenCalledTimes(1);
    expect(mover, "a volta não pode mover de novo").toHaveBeenCalledTimes(1);
  });

  it.each(["lead.won", "lead.lost", "lead.reopened", "lead.assigned"])(
    "gatilho %s (nasce do trigger, sem marca): mover dentro de uma opção é recusado na porta e no motor",
    async (gatilho) => {
      expect(createAutomationRuleSchema.safeParse(regra([AI_DECIDE_MOVE], gatilho)).success, "a porta").toBe(false);

      const fake = adminFake({ rules: [{ id: REGRA, name: "Regra de teste", conditions: [], actions: [AI_DECIDE_MOVE] }], lead: LEAD_NO_FUNIL });
      await runAutomationForEvent(fake.admin, eventoDeLead(gatilho));

      const run = fake.inserts.find((i) => i.table === "automation_rule_runs");
      expect((run!.data.actions_result as Array<Record<string, unknown>>)[0]).toMatchObject({
        type: "ai_decide",
        status: "skipped",
        error: "acao_fecharia_laco",
      });
      expect(decidir, "nem pergunta à IA").not.toHaveBeenCalled();
      expect(mover).not.toHaveBeenCalled();
    },
  );
});

describe("pré-checagem do motor (postponeUntil)", () => {
  it("adiar a ação-alvo adia a decisão inteira — o modelo não é consultado à toa", async () => {
    // Registrado AGORA e sem clone: é o último teste do arquivo, e o registro
    // de executores é por tipo (um mapa só, sem remoção).
    const { registerAction } = await import("@/lib/automation/actions");
    const postpone = vi.fn(async () => "2026-10-04T09:00:00.000Z");
    registerAction({
      type: "create_task",
      postponeUntil: postpone,
      execute: async () => ({ type: "create_task", status: "success" }),
    });

    const ate = await executor().postponeUntil!(ctx({ lead: LEAD_HIDRATADO }), AI_DECIDE.config);

    expect(ate).toBe("2026-10-04T09:00:00.000Z");
    expect(postpone).toHaveBeenCalledWith(expect.anything(), AI_DECIDE.config.opcoes[1]!.acao.config);
    expect(decidir, "adiado não pode gastar token").not.toHaveBeenCalled();
  });
});
