import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionCtx } from "@/lib/automation/types";

vi.mock("@/lib/followup/enroll", () => ({
  enrollFollowupFlow: vi.fn(),
}));

import { enrollFollowupFlow } from "@/lib/followup/enroll";
import {
  EVENTO_SUBSTITUIDO_POR_REGRA,
  MOTIVO_SUBSTITUIDO_POR_REGRA,
  executeStartMessageFlow,
} from "@/lib/automation/actions/start-message-flow";

const enroll = vi.mocked(enrollFollowupFlow);
const POINTER = "11111111-1111-4111-8111-111111111111";

function baseCtx(context: Record<string, unknown>): ActionCtx {
  return {
    admin: {} as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Automação de teste",
    requestId: "evt-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "lead.created",
      entity_kind: "crm_lead",
      entity_id: "lead-1",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context,
  };
}

describe("executeStartMessageFlow", () => {
  beforeEach(() => {
    enroll.mockReset();
  });

  it("skip: sem contato no contexto", async () => {
    const result = await executeStartMessageFlow(baseCtx({ lead: { id: "lead-1" } }), {
      flow_pointer_id: POINTER,
    });
    expect(result).toEqual({
      type: "start_message_flow",
      status: "skipped",
      detail: { reason: "no_contact" },
    });
    expect(enroll).not.toHaveBeenCalled();
  });

  it("skip: fluxo ainda não publicado", async () => {
    enroll.mockResolvedValue({
      ok: false,
      code: "flow_not_active",
      message: "Fluxo não está ativo (precisa estar publicado).",
      status: 422,
    });
    const result = await executeStartMessageFlow(
      baseCtx({ contact: { id: "c-1" } }),
      { flow_pointer_id: POINTER },
    );
    expect(result.status).toBe("skipped");
    expect(result.detail).toEqual({ reason: "flow_not_active" });
    expect(enroll).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-1",
        pointerId: POINTER,
        contactId: "c-1",
        requestId: "rule:rule-1",
      }),
    );
  });

  it("usa contact_id do lead quando contact não veio hidratado", async () => {
    enroll.mockResolvedValue({ ok: true, enrollment: { id: "enr-1" } });
    const result = await executeStartMessageFlow(
      baseCtx({ lead: { id: "lead-1", contact_id: "c-from-lead" } }),
      { flow_pointer_id: POINTER },
    );
    expect(result.status).toBe("success");
    expect(enroll).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contactId: "c-from-lead" }),
    );
  });

  it("falha explícita em inscrição viva (conflict)", async () => {
    enroll.mockResolvedValue({
      ok: false,
      code: "conflict",
      message: "já ativo",
      status: 409,
    });
    const result = await executeStartMessageFlow(
      baseCtx({ contact: { id: "c-1" } }),
      { flow_pointer_id: POINTER },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("live_enrollment_exists");
  });
});

/**
 * `replace_live_flow`: o contato só tem UMA inscrição viva. Sem a opção, a regra
 * perde para o fluxo que chegou antes — medido em produção: o formulário de
 * pedido não confirmava a quem estava no remarketing.
 */
describe("executeStartMessageFlow — replace_live_flow", () => {
  const OUTRO = "22222222-2222-4222-8222-222222222222";
  const CONFLITO = { ok: false as const, code: "conflict", message: "já ativo", status: 409 };

  type Chamada = {
    tabela: string;
    op: "select" | "update" | "insert";
    valor?: Record<string, unknown>;
    filtros: Array<[string, unknown]>;
  };

  /** Supabase de mentira: a leitura devolve `viva`; o UPDATE casa `linhasDoUpdate` linhas. */
  function adminFalso(
    viva: { id: string; pointer_id: string; status: string; current_node_id: string | null } | null,
    linhasDoUpdate = 1,
  ) {
    const chamadas: Chamada[] = [];
    const admin = {
      from(tabela: string) {
        const c: Chamada = { tabela, op: "select", filtros: [] };
        chamadas.push(c);
        const b = {
          select: () => b,
          eq: (k: string, v: unknown) => (c.filtros.push([k, v]), b),
          in: (k: string, v: unknown) => (c.filtros.push([k, v]), b),
          update: (v: Record<string, unknown>) => ((c.op = "update"), (c.valor = v), b),
          insert: async (v: Record<string, unknown>) => {
            c.op = "insert";
            c.valor = v;
            return { error: null };
          },
          maybeSingle: async () => ({ data: viva, error: null }),
          then: (ok: (r: unknown) => unknown) =>
            ok({
              data: Array.from({ length: linhasDoUpdate }, () => ({ id: viva?.id })),
              error: null,
            }),
        };
        return b;
      },
    };
    return { admin: admin as unknown as ActionCtx["admin"], chamadas };
  }

  function ctxCom(admin: ActionCtx["admin"]): ActionCtx {
    return {
      ...baseCtx({ contact: { id: "c-1" } }),
      admin,
      ruleName: "Formulário do site · confirmação",
    };
  }

  beforeEach(() => {
    enroll.mockReset();
  });

  it("⭐ encerra a inscrição de OUTRO fluxo, registra no dossiê dela e inscreve neste", async () => {
    enroll
      .mockResolvedValueOnce(CONFLITO)
      .mockResolvedValueOnce({ ok: true, enrollment: { id: "enr-novo" } });
    const { admin, chamadas } = adminFalso({
      id: "enr-velho",
      pointer_id: OUTRO,
      status: "active",
      current_node_id: "espera-1",
    });

    const r = await executeStartMessageFlow(ctxCom(admin), {
      flow_pointer_id: POINTER,
      replace_live_flow: true,
    });

    expect(r).toEqual({
      type: "start_message_flow",
      status: "success",
      detail: {
        enrollment_id: "enr-novo",
        replaced_enrollment_id: "enr-velho",
        replaced_pointer_id: OUTRO,
      },
    });
    expect(enroll).toHaveBeenCalledTimes(2);

    const update = chamadas.find((c) => c.op === "update");
    expect(update?.tabela).toBe("followup_enrollments");
    expect(update?.valor).toMatchObject({
      status: "cancelled",
      cancel_reason: MOTIVO_SUBSTITUIDO_POR_REGRA,
      next_eval_at: null,
    });
    // A organização vem da regra, e o UPDATE só casa estado que a regra pode encerrar.
    expect(update?.filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", "org-1"],
        ["id", "enr-velho"],
        ["status", ["active", "waiting_reply"]],
      ]),
    );

    const evento = chamadas.find((c) => c.op === "insert");
    expect(evento?.tabela).toBe("followup_enrollment_events");
    expect(evento?.valor).toMatchObject({
      organization_id: "org-1",
      enrollment_id: "enr-velho",
      node_id: "espera-1",
      event_type: EVENTO_SUBSTITUIDO_POR_REGRA,
      payload: {
        rule_id: "rule-1",
        rule_name: "Formulário do site · confirmação",
        new_pointer_id: POINTER,
      },
    });
  });

  it("não recomeça o MESMO fluxo: o contato já está nele", async () => {
    enroll.mockResolvedValue(CONFLITO);
    const { admin, chamadas } = adminFalso({
      id: "enr-velho",
      pointer_id: POINTER,
      status: "waiting_reply",
      current_node_id: "x",
    });

    const r = await executeStartMessageFlow(ctxCom(admin), {
      flow_pointer_id: POINTER,
      replace_live_flow: true,
    });

    expect(r).toMatchObject({
      status: "failed",
      error: "live_enrollment_exists",
      detail: { reason: "same_flow" },
    });
    expect(chamadas.some((c) => c.op === "update")).toBe(false);
    expect(enroll).toHaveBeenCalledTimes(1);
  });

  it.each(["paused_handoff", "paused_manual"])(
    "não passa por cima de fluxo %s: uma pessoa está nele",
    async (status) => {
      enroll.mockResolvedValue(CONFLITO);
      const { admin, chamadas } = adminFalso({
        id: "enr-velho",
        pointer_id: OUTRO,
        status,
        current_node_id: "x",
      });

      const r = await executeStartMessageFlow(ctxCom(admin), {
        flow_pointer_id: POINTER,
        replace_live_flow: true,
      });

      expect(r).toMatchObject({ status: "failed", detail: { reason: "live_enrollment_paused" } });
      expect(chamadas.some((c) => c.op === "update" || c.op === "insert")).toBe(false);
      expect(enroll).toHaveBeenCalledTimes(1);
    },
  );

  it("sem a opção, nada muda: a regra nem olha a inscrição viva", async () => {
    enroll.mockResolvedValue(CONFLITO);
    const { admin, chamadas } = adminFalso({
      id: "enr-velho",
      pointer_id: OUTRO,
      status: "active",
      current_node_id: "x",
    });

    const r = await executeStartMessageFlow(ctxCom(admin), { flow_pointer_id: POINTER });

    expect(r).toMatchObject({ status: "failed", error: "live_enrollment_exists" });
    expect(chamadas).toHaveLength(0);
  });

  it("corrida: o motor encerrou a inscrição antes do UPDATE — tenta uma vez e devolve o conflito se ainda houver", async () => {
    enroll.mockResolvedValue(CONFLITO);
    const { admin, chamadas } = adminFalso(
      { id: "enr-velho", pointer_id: OUTRO, status: "active", current_node_id: "x" },
      0,
    );

    const r = await executeStartMessageFlow(ctxCom(admin), {
      flow_pointer_id: POINTER,
      replace_live_flow: true,
    });

    expect(r).toMatchObject({ status: "failed", detail: { reason: "live_enrollment_exists" } });
    expect(chamadas.some((c) => c.op === "insert")).toBe(false);
    expect(enroll).toHaveBeenCalledTimes(2);
  });
});
