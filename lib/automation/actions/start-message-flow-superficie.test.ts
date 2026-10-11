import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx } from "@/lib/automation/types";

/**
 * A ação `start_message_flow` enxerga as DUAS superfícies (#2647).
 *
 * ─── Por que dois caminhos e não um ────────────────────────────────────────
 *
 * Acompanhar o fluxo de atendimento pelo enroll de follow-up não é questão de
 * gosto: `enrollFollowupFlow` recusa superfície `atendimento`
 * (`flow_not_enrollable`, 422) e o BANCO recusaria o status `active` que ele
 * insere (`trg_enrollment_superficie_coerente`, 23514) — roteiro de atendimento
 * só existe como `coletando`, conduzido no turno do agente. Quem o começa no
 * produto (palavra-gatilho, roteador) chama `iniciarFluxoDeAtendimento`, e é
 * por ali que a automação também passa a alcançá-lo.
 *
 * A régua RETROCOMPATÍVEL: config sem `surface` é o follow-up de sempre, byte a
 * byte — toda regra já gravada continua apontando para o MESMO fluxo e o enroll
 * não muda. `surface: "atendimento"` é a única porta nova.
 */

vi.mock("@/lib/followup/enroll", () => ({ enrollFollowupFlow: vi.fn() }));
vi.mock("@/lib/followup/atendimento", () => ({ iniciarFluxoDeAtendimento: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn() }));
vi.mock("@/lib/atendimento/origem-automacao", () => ({ serviceForAutomation: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: vi.fn() }));

import { serviceForAutomation } from "@/lib/atendimento/origem-automacao";
import { executeStartMessageFlow } from "@/lib/automation/actions/start-message-flow";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { iniciarFluxoDeAtendimento } from "@/lib/followup/atendimento";
import { enrollFollowupFlow } from "@/lib/followup/enroll";
import { moduloLigado } from "@/lib/instalacao/modulos";

const enroll = vi.mocked(enrollFollowupFlow);
const iniciar = vi.mocked(iniciarFluxoDeAtendimento);
const doPool = vi.mocked(getRequestPool);
const servico = vi.mocked(serviceForAutomation);
const modulo = vi.mocked(moduloLigado);

const POINTER = "11111111-1111-4111-8111-111111111111";

function baseCtx(): ActionCtx {
  return {
    admin: {} as ActionCtx["admin"],
    organizationId: "org-1",
    ruleId: "rule-1",
    ruleName: "Automação de teste",
    requestId: "evt-1",
    event: {
      id: "evt-1",
      organization_id: "org-1",
      event_type: "lead.stage_changed",
      entity_kind: "crm_lead",
      entity_id: "lead-1",
      payload: {},
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context: { contact: { id: "c-1" } },
  };
}

describe("start_message_flow — a superfície escolhe o caminho (#2647)", () => {
  beforeEach(() => {
    enroll.mockReset();
    iniciar.mockReset();
    doPool.mockReset();
    servico.mockReset();
    modulo.mockReset();
    modulo.mockResolvedValue(true);
  });

  it("sem superfície declarada continua inscrevendo no follow-up, como antes", async () => {
    enroll.mockResolvedValue({ ok: true, enrollment: { id: "enr-1" } });

    const result = await executeStartMessageFlow(baseCtx(), { flow_pointer_id: POINTER });

    expect(result).toEqual({
      type: "start_message_flow",
      status: "success",
      detail: { enrollment_id: "enr-1" },
    });
    expect(enroll).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org-1", pointerId: POINTER, contactId: "c-1" }),
    );
    // O caminho do roteiro nem é aberto: sem pool, sem `iniciarFluxoDeAtendimento`.
    expect(doPool).not.toHaveBeenCalled();
    expect(iniciar).not.toHaveBeenCalled();
  });

  it("superfície 'atendimento' resolve e arma o fluxo de atendimento publicado", async () => {
    const pool = { nome: "pool-falso" } as unknown as ReturnType<typeof getRequestPool>;
    doPool.mockReturnValue(pool);
    servico.mockResolvedValue({ conversation_id: "conv-1" } as never);
    iniciar.mockResolvedValue("enr-2");

    const result = await executeStartMessageFlow(baseCtx(), {
      flow_pointer_id: POINTER,
      surface: "atendimento",
    });

    expect(result).toEqual({
      type: "start_message_flow",
      status: "success",
      detail: { enrollment_id: "enr-2" },
    });
    // Mesma entrada de palavra-gatilho e roteador: o MESMO pointer, o mesmo pool,
    // e a origem dita de onde veio (o evento da trilha do roteiro).
    expect(iniciar).toHaveBeenCalledWith(pool, {
      organizationId: "org-1",
      contactId: "c-1",
      flowPointerId: POINTER,
      conversationId: "conv-1",
      origem: "automacao",
    });
    expect(enroll).not.toHaveBeenCalled();
  });

  it("roteiro que não começou vira pulo explicado, não silêncio", async () => {
    const pool = { nome: "pool-falso" } as unknown as ReturnType<typeof getRequestPool>;
    doPool.mockReturnValue(pool);
    servico.mockResolvedValue({ conversation_id: "conv-1" } as never);
    iniciar.mockResolvedValue(null);

    const result = await executeStartMessageFlow(baseCtx(), {
      flow_pointer_id: POINTER,
      surface: "atendimento",
    });

    expect(result.status).toBe("skipped");
    expect(result.detail).toEqual({ reason: "roteiro_nao_iniciado" });
  });

  it("com o módulo Fluxos de atendimento desligado, não arma roteiro que ninguém conduz", async () => {
    modulo.mockResolvedValue(false);

    const result = await executeStartMessageFlow(baseCtx(), {
      flow_pointer_id: POINTER,
      surface: "atendimento",
    });

    expect(result).toEqual({
      type: "start_message_flow",
      status: "skipped",
      detail: { reason: "modulo_desligado" },
    });
    expect(modulo).toHaveBeenCalledWith(expect.anything(), "fluxos_atendimento");
    expect(iniciar).not.toHaveBeenCalled();
    expect(doPool).not.toHaveBeenCalled();
  });
});
