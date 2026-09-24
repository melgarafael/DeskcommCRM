/**
 * O coração da espera imune: o que a reatividade faz — e o que ela NÃO faz —
 * quando o contato manda mensagem e há uma inscrição dormindo.
 *
 * A feature não é um `if` de imunidade nesta camada: é a ausência de `dormente`
 * em `LIVE_STATUSES`. Por isso os casos abaixo medem COMPORTAMENTO OBSERVÁVEL
 * (nenhum evento gravado, nenhum patch aplicado), não a existência de um ramo.
 *
 * O que se prova aqui, e que nenhum outro teste do repo provava:
 *   1. mensagem do contato não encurta nem cancela a espera dormente;
 *   2. `cancel_on_reply` — a política que cancela tudo o mais — também não a alcança;
 *   3. STOP/opt-out alcança, porque hard stop não admite exceção de status;
 *   4. quem não dorme continua reagindo exatamente como antes.
 */

import { describe, expect, it, vi } from "vitest";

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

function montarDb(
  inscricoes: LiveEnrollmentRef[],
  opts: { bloqueado?: boolean } = {},
): { db: ReactivityAdminClient; espiao: Espiao } {
  const espiao: Espiao = { eventos: [], patches: [] };

  const db: ReactivityAdminClient = {
    async loadConversationContactId() {
      return CONTATO;
    },
    async loadContactBlocked() {
      return opts.bloqueado ?? false;
    },
    async loadLiveEnrollmentsForContact(_org, _contato, statuses) {
      // O filtro do banco, reproduzido: é ele que decide quem a reatividade
      // sequer enxerga, e é nele que a imunidade mora.
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
    id: "enr-1",
    status: "active",
    current_node_id: "w1",
    steps_taken: 3,
    pointer_id: "ptr-1",
    handoff_policy: "pause",
    trigger_config: null,
    ...over,
  };
}

function eventoDeInbound(over: Partial<EventRow> = {}): EventRow {
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
    ...over,
  };
}

describe("reatividade — a inscrição dormente", () => {
  it("não é tocada quando o contato manda mensagem", async () => {
    // O caso que a feature existe para garantir: a cliente de manutenção fala
    // com o estúdio durante os 28 dias, e o retorno continua marcado para a
    // data certa. Sem isto, ou a cadência morre, ou dispara na hora errada.
    const { db, espiao } = montarDb([inscricao({ status: "dormente" })]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(s.reacted).toBe(0);
    expect(espiao.eventos).toEqual([]);
    expect(espiao.patches).toEqual([]);
  });

  it("não é cancelada nem por `cancel_on_reply`", async () => {
    // `cancel_on_reply` é a política mais agressiva do motor — cancela inscrição
    // parada em espera e em waiting_reply. Ela decide por TRIGGER, e o dormente
    // nem chega até ela: não está no conjunto carregado.
    const { db, espiao } = montarDb([
      inscricao({ status: "dormente", trigger_config: { kind: "manual", cancel_on_reply: true } }),
    ]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(s.reacted).toBe(0);
    expect(espiao.patches).toEqual([]);
  });

  it("É cancelada no opt-out — hard stop não tem exceção de status", async () => {
    // Uma espera que sobrevivesse ao "pare de me mandar mensagem" voltaria a
    // falar com quem pediu silêncio, um mês depois. LGPD e anti-ban alcançam
    // todo mundo.
    const { db, espiao } = montarDb([inscricao({ status: "dormente" })], { bloqueado: true });

    const s = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(s.reacted).toBe(1);
    expect(espiao.patches[0]?.patch.status).toBe("cancelled");
    expect(espiao.patches[0]?.patch.outcome).toBe("opted_out");
  });
});

describe("reatividade — quem não dorme segue igual (não-regressão)", () => {
  it("espera comum é acordada pela mensagem", async () => {
    const { db, espiao } = montarDb([inscricao({ status: "active" })]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(s.reacted).toBe(1);
    expect(espiao.eventos.map((e) => e.event_type)).toContain("inbound_woke");
    expect(espiao.patches[0]?.patch.updated_at).toBeUndefined();
    expect(espiao.patches[0]?.patch.next_eval_at).toBeDefined();
  });

  it("espera comum com `cancel_on_reply` é cancelada", async () => {
    const { db, espiao } = montarDb([
      inscricao({ status: "active", trigger_config: { kind: "manual", cancel_on_reply: true } }),
    ]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(s.reacted).toBe(1);
    expect(espiao.patches[0]?.patch.outcome).toBe("replied");
  });

  it("dormente e comum convivem: um dorme, o outro reage", async () => {
    // O contato pode ter as duas ao mesmo tempo — é exatamente o que o status
    // `dormente` libera ao ficar fora do índice único anti-spam.
    const { db, espiao } = montarDb([
      inscricao({ id: "enr-dorme", status: "dormente" }),
      inscricao({ id: "enr-anda", status: "active" }),
    ]);

    const s = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(s.reacted).toBe(1);
    expect(espiao.eventos.every((e) => e.enrollment_id === "enr-anda")).toBe(true);
  });

  it("não acorda espera estacionada depois da mensagem", async () => {
    const { db, espiao } = montarDb([
      inscricao({
        status: "waiting_reply",
        updated_at: "2026-09-20T19:35:47.000Z",
      }),
    ]);

    const s = await applyReactivityEvent(
      db,
      () => new Date(AGORA),
      eventoDeInbound({ created_at: "2026-09-20T19:35:45.000Z" }),
    );

    expect(s.reacted).toBe(0);
    expect(espiao.eventos).toEqual([]);
    expect(espiao.patches).toEqual([]);
  });
});

describe("reatividade — o handoff não alcança o dormente", () => {
  it("não pausa quem dorme", async () => {
    // Pausar tiraria o relógio (`paused_handoff` não tem `next_eval_at`), e
    // retomar dá a graça de 30 min: a espera de 28 dias acordaria quase um mês
    // cedo. Quem assume a conversa hoje não decide sobre o retorno de daqui a
    // um mês.
    const { db, espiao } = montarDb([inscricao({ status: "dormente" })]);
    const espiaoCarga = vi.spyOn(db, "loadLiveEnrollmentsForContact");

    const s = await applyReactivityEvent(db, () => new Date(AGORA), {
      id: "44444444-4444-4444-8444-444444444444",
      organization_id: ORG,
      event_type: "ai.handoff_triggered",
      payload: { conversation_id: "conv-1" },
    } as never);

    expect(s.reacted).toBe(0);
    expect(espiao.patches).toEqual([]);
    // E a prova de COMO: o handoff carrega com a lista padrão, sem `dormente`.
    for (const chamada of espiaoCarga.mock.calls) {
      expect(chamada[2] ?? []).not.toContain("dormente");
    }
  });
});
