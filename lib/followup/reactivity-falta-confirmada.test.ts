/**
 * O MOTOR NO GATILHO «FALTA CONFIRMADA PELA EQUIPE» (#3400).
 *
 * ## Por que o default deste kind é `true`, e não `false`
 *
 * `cancel_on_reply` nasce desligado para todo gatilho, e isso está certo: quem
 * montou o fluxo escolheu. Em `appointment_no_show` não há escolha a fazer — o
 * interruptor da tela nasce LIGADO e travado, porque a sequência de falta só
 * existe para o silêncio de quem não compareceu (doutrina dos modelos de
 * clínica: quem marca consulta é o atendimento, que tem a agenda na mão).
 *
 * A tela mentia: mostrava ligado e gravava sem o campo. Persistir no próximo
 * salvamento consertaria só o futuro — todo fluxo já salvo pela tela antiga
 * continuaria roteando por cima do paciente que acabou de responder, que é
 * exatamente o efeito relatado. Por isso a garantia mora AQUI, onde o
 * comportamento é decidido: ausente nesse kind significa `true`.
 *
 * O que NÃO se abre mão: um `false` DECLARADO (API, importação, portabilidade)
 * continua respeitado. Default não é sequestro de configuração.
 *
 * O que este arquivo não prova: qual caminho de código gravou o
 * `trigger_config`. Isso é a tela, medida em
 * `app/app/ai/followups/[id]/_components/TriggerConfigControl-falta.test.tsx`.
 */

import { describe, expect, it } from "vitest";

import {
  applyReactivityEvent,
  type LiveEnrollmentRef,
  type ReactivityAdminClient,
} from "./reactivity";
import type { EnrollmentPatch } from "./engine";
import type { EventRow } from "@/lib/event-log/dispatcher";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const AGORA = "2026-09-18T12:00:00.000Z";

interface Espiao {
  eventos: Array<{ event_type: string; enrollment_id: string }>;
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
      espiao.eventos.push({ event_type: event.event_type, enrollment_id: event.enrollment_id });
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
    id: "enr-falta",
    status: "waiting_reply",
    current_node_id: "w1",
    steps_taken: 1,
    pointer_id: "ptr-falta",
    handoff_policy: "pause",
    trigger_config: null,
    ...over,
  };
}

function eventoDeInbound(): EventRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: null,
    payload: { contact_id: CONTATO, direction: "inbound" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

/** O gatilho como a tela antiga gravava: sem o campo. */
const FALTA_SEM_O_CAMPO = { kind: "appointment_no_show", params: {} };

describe("reatividade — falta confirmada cancela ao responder", () => {
  it("config SEM o campo (tela antiga) cancela a espera", async () => {
    const { db, espiao } = montarDb([
      inscricao({ status: "waiting_reply", trigger_config: FALTA_SEM_O_CAMPO }),
    ]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(s.reacted).toBe(1);
    expect(espiao.eventos.map((e) => e.event_type)).toContain("reactivity_replied");
    expect(espiao.patches[0]?.patch.status).toBe("cancelled");
    expect(espiao.patches[0]?.patch.outcome).toBe("replied");
    expect(espiao.patches[0]?.patch.cancel_reason).toBe("cancel_on_reply");
  });

  it("o mesmo vale para o toque com timer (`active`), não só para `waiting_reply`", async () => {
    const { db, espiao } = montarDb([
      inscricao({ status: "active", trigger_config: FALTA_SEM_O_CAMPO }),
    ]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(s.reacted).toBe(1);
    expect(espiao.patches[0]?.patch.outcome).toBe("replied");
  });

  it("`cancel_on_reply: false` DECLARADO continua respeitado — o default não sequestra configuração", async () => {
    const { db, espiao } = montarDb([
      inscricao({
        status: "waiting_reply",
        trigger_config: { kind: "appointment_no_show", params: {}, cancel_on_reply: false },
      }),
    ]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(s.reacted).toBe(1);
    expect(espiao.patches[0]?.patch.outcome).not.toBe("replied");
    expect(espiao.eventos.map((e) => e.event_type)).toContain("inbound_woke");
  });

  it("não-regressão: outro kind sem o campo segue acordando o classify", async () => {
    const { db, espiao } = montarDb([
      inscricao({ status: "waiting_reply", trigger_config: { kind: "manual" } }),
    ]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(s.reacted).toBe(1);
    expect(espiao.eventos.map((e) => e.event_type)).toContain("inbound_woke");
    expect(espiao.eventos.map((e) => e.event_type)).not.toContain("reactivity_replied");
  });
});
