import { describe, it, expect } from "vitest";
import {
  createWebhookSourceSchema,
  updateWebhookSourceSchema,
  createAutomationRuleSchema,
  updateAutomationRuleSchema,
  conditionSchema,
} from "./webhooks";
import { conditionsSchema } from "@/lib/automation/conditions";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

describe("createWebhookSourceSchema", () => {
  it("accepts a valid payload", () => {
    const r = createWebhookSourceSchema.safeParse({
      name: "Landing page X",
      default_pipeline_id: UUID,
      default_stage_id: UUID2,
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty name", () => {
    const r = createWebhookSourceSchema.safeParse({
      name: "",
      default_pipeline_id: UUID,
      default_stage_id: UUID2,
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-uuid default_pipeline_id", () => {
    const r = createWebhookSourceSchema.safeParse({
      name: "X",
      default_pipeline_id: "not-uuid",
      default_stage_id: UUID2,
    });
    expect(r.success).toBe(false);
  });

  it("rejects secret shorter than 16 chars", () => {
    const r = createWebhookSourceSchema.safeParse({
      name: "X",
      default_pipeline_id: UUID,
      default_stage_id: UUID2,
      secret: "short",
    });
    expect(r.success).toBe(false);
  });
});

describe("createAutomationRuleSchema", () => {
  it("accepts a happy path with one action of each type", () => {
    const base = {
      name: "Regra 1",
      trigger_event: "lead.created" as const,
      conditions: [],
    };
    const actionCases = [
      { type: "create_or_move_lead", config: { pipeline_id: UUID, stage_id: UUID2 } },
      { type: "send_whatsapp_message", config: { channel_session_id: UUID, template: "Oi!" } },
      { type: "add_tag", config: { tags: ["vip"] } },
      { type: "assign_owner", config: { user_id: UUID } },
      { type: "call_webhook", config: { url: "https://example.com/hook" } },
      { type: "start_message_flow", config: { flow_pointer_id: UUID } },
    ];
    for (const action of actionCases) {
      const r = createAutomationRuleSchema.safeParse({ ...base, actions: [action] });
      expect(r.success).toBe(true);
    }
  });

  it("rejects trigger_event outside the enum", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "Regra",
      trigger_event: "lead.deleted",
      actions: [{ type: "add_tag", config: { tags: ["x"] } }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty actions array", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "Regra",
      trigger_event: "lead.created",
      actions: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects start_message_flow without uuid pointer", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "Regra",
      trigger_event: "lead.created",
      actions: [{ type: "start_message_flow", config: { flow_pointer_id: "not-uuid" } }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an action of unknown type", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "Regra",
      trigger_event: "lead.created",
      actions: [{ type: "delete_lead", config: {} }],
    });
    expect(r.success).toBe(false);
  });

  it("strips is_active on create even if sent", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "Regra",
      trigger_event: "lead.created",
      actions: [{ type: "add_tag", config: { tags: ["x"] } }],
      is_active: true,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect("is_active" in r.data).toBe(false);
    }
  });
});

describe("conditionSchema", () => {
  it("rejects op outside the known set (#2727 ampliou o conjunto)", () => {
    const r = conditionSchema.safeParse({ field: "status", op: "regex", value: "won" });
    expect(r.success).toBe(false);
  });

  it("aceita os operadores novos de #2727", () => {
    for (const op of ["not_contains", "is_empty", "is_not_empty", "gt", "gte", "lt", "lte"]) {
      expect(conditionSchema.safeParse({ field: "status", op, value: "won" }).success).toBe(true);
    }
  });

  it("accepts a valid condition", () => {
    const r = conditionSchema.safeParse({ field: "status", op: "eq", value: "won" });
    expect(r.success).toBe(true);
  });
});

/**
 * #2727 — as condições de uma regra: a lista simples (formato antigo) e o grupo
 * do TOPO (`{all}` / `{any}`). Aninhar grupo em grupo NÃO entra: nenhuma tela o
 * edita e o formulário o perderia silenciosamente (o CR do #2727 escolheu
 * fechar na porta da API em vez de deixar a regra encolher ao ser salva).
 */
describe("conditionsSchema (#2727)", () => {
  const linha = { field: "status", op: "eq", value: "won" };

  it("aceita a lista simples — o formato guardado antes desta mudança", () => {
    expect(conditionsSchema.safeParse([linha]).success).toBe(true);
    expect(conditionsSchema.safeParse([]).success).toBe(true);
  });

  it("aceita {all:…} e {any:…}", () => {
    expect(conditionsSchema.safeParse({ all: [linha] }).success).toBe(true);
    expect(conditionsSchema.safeParse({ any: [linha] }).success).toBe(true);
  });

  it("RECUSA grupo dentro de grupo — só o grupo do TOPO", () => {
    expect(conditionsSchema.safeParse({ all: [linha, { any: [linha] }] }).success).toBe(false);
    expect(conditionsSchema.safeParse({ any: [{ all: [linha] }] }).success).toBe(false);
    // O mesmo conteúdo, sem aninhar, passa: o que se recusa é o grupo interior.
    expect(conditionsSchema.safeParse({ any: [linha, linha] }).success).toBe(true);
  });

  it("recusa {all:…} e {any:…} no MESMO grupo (o combinador é um só)", () => {
    expect(conditionsSchema.safeParse({ all: [linha], any: [linha] }).success).toBe(false);
  });

  it("recusa operador desconhecido DENTRO de um grupo", () => {
    const r = conditionsSchema.safeParse({ any: [{ field: "a", op: "regex", value: "x" }] });
    expect(r.success).toBe(false);
  });

  it("o teto é 10 no TOPO, nos dois formatos (não 50 por nível)", () => {
    const n = (quantos: number) => Array.from({ length: quantos }, () => linha);
    expect(conditionsSchema.safeParse(n(10)).success).toBe(true);
    expect(conditionsSchema.safeParse(n(11)).success).toBe(false);
    expect(conditionsSchema.safeParse({ any: n(10) }).success).toBe(true);
    expect(conditionsSchema.safeParse({ any: n(11) }).success).toBe(false);
    expect(conditionsSchema.safeParse({ all: n(11) }).success).toBe(false);
  });
});

describe("updateAutomationRuleSchema", () => {
  it("accepts {is_active: true} alone", () => {
    const r = updateAutomationRuleSchema.safeParse({ is_active: true });
    expect(r.success).toBe(true);
  });
});


describe("#1612: gatilhos de desfecho e o opt-in do responsável", () => {
  it("aceita appointment.completed e appointment.no_show como trigger_event", () => {
    for (const trigger_event of ["appointment.completed", "appointment.no_show"] as const) {
      const r = createAutomationRuleSchema.safeParse({
        name: "Aviso de desfecho",
        trigger_event,
        actions: [{ type: "call_webhook", config: { url: "https://example.com/hook" } }],
      });
      expect(r.success, trigger_event).toBe(true);
    }
  });

  it("call_webhook aceita include_owner booleano", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "Regra",
      trigger_event: "appointment.created",
      actions: [
        { type: "call_webhook", config: { url: "https://example.com/hook", include_owner: true } },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("recusa include_owner que não é booleano: opt-in malformado não é opt-in", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "Regra",
      trigger_event: "appointment.created",
      actions: [
        { type: "call_webhook", config: { url: "https://example.com/hook", include_owner: "sim" } },
      ],
    });
    expect(r.success).toBe(false);
  });
});


describe("form source AI authorization configuration", () => {
  it("allows renaming an existing source and trims outer whitespace", () => {
    expect(updateWebhookSourceSchema.parse({ name: "  Campanha de Sites  " })).toEqual({
      name: "Campanha de Sites",
    });
    expect(updateWebhookSourceSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("accepts a boolean on update and rejects coercion", () => {
    expect(updateWebhookSourceSchema.parse({ authorize_ai_on_capture: true })).toEqual({ authorize_ai_on_capture: true });
    expect(updateWebhookSourceSchema.safeParse({ authorize_ai_on_capture: "true" }).success).toBe(false);
  });
  it("creation keeps authorization off until explicit source configuration", () => {
    expect(createWebhookSourceSchema.parse({ name: "Synthetic", default_pipeline_id: UUID, default_stage_id: UUID2, authorize_ai_on_capture: true })).not.toHaveProperty("authorize_ai_on_capture");
  });
});

// #2041 — o rodízio na ação "Atribuir a um atendente". A forma antiga ({ user_id })
// precisa continuar válida e sair do parse SEM `modo`: é o que está gravado nas
// regras de quem já instalou.
describe("assign_owner: atendente fixo ou rodízio", () => {
  const regra = (actions: unknown[]) =>
    createAutomationRuleSchema.safeParse({ name: "Rodízio", trigger_event: "lead.created", actions });
  const rodizio = (fila: unknown[]) => ({ type: "assign_owner", config: { modo: "rodizio", fila } });

  it("a forma de sempre ({ user_id }) segue válida e sem modo inventado", () => {
    const r = regra([{ type: "assign_owner", config: { user_id: UUID } }]);
    expect(r.success).toBe(true);
    expect(r.success && r.data.actions[0]?.config).toEqual({ user_id: UUID });
  });

  it("aceita a fila em ordem, com pausa", () => {
    const fila = [{ user_id: UUID, pausado: false }, { user_id: UUID2, pausado: true }];
    const r = regra([rodizio(fila)]);
    expect(r.success).toBe(true);
    expect(r.success && r.data.actions[0]?.config).toEqual({ modo: "rodizio", fila });
  });

  it("recusa fila vazia, pessoa repetida e modo desconhecido, apontando o campo", () => {
    const vazia = regra([rodizio([])]);
    expect(vazia.success).toBe(false);
    expect(vazia.error?.issues[0]?.path).toEqual(["actions", 0, "config", "fila"]);

    const repetida = regra([rodizio([{ user_id: UUID, pausado: false }, { user_id: UUID, pausado: true }])]);
    expect(repetida.success).toBe(false);
    expect(repetida.error?.issues[0]?.path).toEqual(["actions", 0, "config", "fila", 1, "user_id"]);

    expect(regra([{ type: "assign_owner", config: { modo: "sorteio", user_id: UUID } }]).success).toBe(false);
  });

  it("uma regra tem no máximo um rodízio, e nunca dentro do ai_decide", () => {
    const fila = [{ user_id: UUID, pausado: false }];
    expect(regra([rodizio(fila), rodizio(fila)]).success).toBe(false);
    expect(regra([rodizio(fila), { type: "assign_owner", config: { user_id: UUID2 } }]).success).toBe(true);
    const dentroDaIa = regra([
      {
        type: "ai_decide",
        config: {
          custo_de_token: true,
          instrucao: "Escolha",
          opcoes: [
            { id: "a", rotulo: "A", acao: rodizio(fila) },
            { id: "b", rotulo: "B", acao: { type: "add_tag", config: { tags: ["x"] } } },
          ],
        },
      },
    ]);
    expect(dentroDaIa.success).toBe(false);
    const patch = updateAutomationRuleSchema.safeParse({ actions: [rodizio(fila), rodizio(fila)] });
    expect(patch.success).toBe(false);
  });
});
