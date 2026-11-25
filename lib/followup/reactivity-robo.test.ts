import { describe, expect, it } from "vitest";

import {
  applyReactivityEvent,
  EVENTO_DE_ROBO_IGNORADO,
  type LiveEnrollmentRef,
  type ReactivityAdminClient,
} from "./reactivity";
import type { EnrollmentPatch } from "./engine";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const AGORA = "2026-11-25T18:00:00.000Z";

interface Espiao {
  eventos: Array<{ event_type: string; enrollment_id: string; idempotency_key: string }>;
  patches: Array<{ id: string; patch: EnrollmentPatch }>;
}

function montarDb(inscricoes: LiveEnrollmentRef[]): {
  db: ReactivityAdminClient;
  espiao: Espiao;
} {
  const espiao: Espiao = { eventos: [], patches: [] };

  const db: ReactivityAdminClient = {
    async loadConversationContactId() {
      return CONTATO;
    },
    async loadContactBlocked() {
      return false;
    },
    async loadLiveEnrollmentsForContact(_org, _contato, statuses) {
      const permitidos = statuses ?? ["active", "waiting_reply", "paused_handoff"];
      return inscricoes.filter((e) => permitidos.includes(e.status));
    },
    async insertEnrollmentEvent(event) {
      espiao.eventos.push({
        event_type: event.event_type,
        enrollment_id: event.enrollment_id,
        idempotency_key: event.idempotency_key,
      });
      return { inserted: true };
    },
    async updateEnrollment(id, _org, patch) {
      espiao.patches.push({ id, patch });
    },
    async agoraNoBanco() {
      return AGORA;
    },
  };

  return { db, espiao };
}

function inscricao(over: Partial<LiveEnrollmentRef> = {}): LiveEnrollmentRef {
  return {
    id: "enr-1",
    status: "waiting_reply",
    current_node_id: "w1",
    steps_taken: 1,
    pointer_id: "ptr-1",
    handoff_policy: "pause",
    trigger_config: { kind: "lead_created", cancel_on_reply: true },
    ...over,
  };
}

function eventoInbound(bodyPreview: string): EventRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: null,
    payload: { contact_id: CONTATO, direction: "inbound", body_preview: bodyPreview },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

describe("reatividade — resposta automática de robô em cancel_on_reply (#5262)", () => {
  it("não cancela nem desperta inscrição com cancel_on_reply diante de menu numerado", async () => {
    const { db, espiao } = montarDb([inscricao({ status: "waiting_reply" })]);

    const res = await applyReactivityEvent(
      db,
      () => new Date(AGORA),
      eventoInbound("1 - Serviços\n2 - Valores"),
    );

    expect(res.matched).toBe(true);
    expect(res.reacted).toBe(0);
    expect(espiao.patches).toEqual([]);
    expect(espiao.eventos.map((e) => e.event_type)).toEqual([EVENTO_DE_ROBO_IGNORADO]);
  });

  it("não cancela inscrição active com timer diante de saudação automática declarada de robô", async () => {
    const { db, espiao } = montarDb([inscricao({ status: "active" })]);

    const res = await applyReactivityEvent(
      db,
      () => new Date(AGORA),
      eventoInbound("Esta é uma mensagem automática de boas-vindas."),
    );

    expect(res.reacted).toBe(0);
    expect(espiao.patches).toEqual([]);
    expect(espiao.eventos.map((e) => e.event_type)).toEqual([EVENTO_DE_ROBO_IGNORADO]);
  });

  it("continua cancelando normalmente quando uma pessoa responde", async () => {
    const { db, espiao } = montarDb([inscricao({ status: "waiting_reply" })]);

    const res = await applyReactivityEvent(
      db,
      () => new Date(AGORA),
      eventoInbound("Oi, pode me passar os valores?"),
    );

    expect(res.reacted).toBe(1);
    expect(espiao.patches[0]?.patch.status).toBe("cancelled");
    expect(espiao.patches[0]?.patch.outcome).toBe("replied");
    expect(espiao.eventos.map((e) => e.event_type)).toContain("reactivity_replied");
  });
});
