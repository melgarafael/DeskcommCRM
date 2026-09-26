import { describe, it, expect } from "vitest";
import {
  createWebhookSourceSchema,
  createAutomationRuleSchema,
  updateAutomationRuleSchema,
  conditionSchema,
} from "./webhooks";

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
  it("rejects op outside eq/neq/contains", () => {
    const r = conditionSchema.safeParse({ field: "status", op: "gt", value: "won" });
    expect(r.success).toBe(false);
  });

  it("accepts a valid condition", () => {
    const r = conditionSchema.safeParse({ field: "status", op: "eq", value: "won" });
    expect(r.success).toBe(true);
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
