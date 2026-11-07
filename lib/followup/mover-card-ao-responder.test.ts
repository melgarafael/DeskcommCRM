/**
 * #3974 — "quando o cliente responder, mover o card para a etapa X", ao lado de
 * "cancelar ao responder", no gatilho de ETAPA.
 *
 * A opção mora no `trigger_config` do pointer (`move_to_stage_on_reply`, irmã de
 * `cancel_on_reply`) e quem a executa é a reatividade de `message.received` —
 * o mesmo consumidor que já cancela a inscrição quando o cliente responde. O
 * card movido é o negócio do contato QUE ESTÁ NA ETAPA DO GATILHO: é esse o card
 * que o fluxo armou, e é ele que a resposta tira da etapa. Contato com dois
 * negócios em funis diferentes não faz o card do outro funil andar.
 *
 * O que se mede aqui é o comportamento da reatividade por inteiro (nenhum
 * Postgres): quais eventos ficam na trilha da inscrição, que patch é aplicado e
 * — o que mais importa — quando o escritor de etapa NÃO é chamado.
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
const ETAPA_ORCAMENTO = "33333333-3333-4333-8333-333333333333";
const ETAPA_NEGOCIACAO = "44444444-4444-4444-8444-444444444444";
const AGORA = "2026-11-05T12:00:00.000Z";

interface Mudanca {
  organization_id: string;
  enrollment_id: string;
  contact_id: string;
  etapa_de_origem: string;
  etapa_de_destino: string;
}

interface Espiao {
  eventos: Array<{ event_type: string; enrollment_id: string; idempotency_key: string; payload: Record<string, unknown> }>;
  patches: Array<{ id: string; patch: EnrollmentPatch }>;
  mudancas: Mudanca[];
}

type ResultadoDoMove = { ok: true } | { ok: false; motivo: "sem_negocio_na_etapa" | "recusado"; erro?: string };

function montarDb(
  inscricoes: LiveEnrollmentRef[],
  opts: {
    /** O que o escritor de etapa responde. `null` = dublê sem o escritor. */
    resultado?: ResultadoDoMove | null;
    /** Chaves idempotentes que o banco já tem (re-drain). */
    jaAplicadas?: string[];
  } = {},
): { db: ReactivityAdminClient; espiao: Espiao } {
  const espiao: Espiao = { eventos: [], patches: [], mudancas: [] };
  const aplicadas = new Set(opts.jaAplicadas ?? []);
  const resultado = opts.resultado === undefined ? ({ ok: true } as const) : opts.resultado;

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
      if (aplicadas.has(event.idempotency_key)) return { inserted: false };
      aplicadas.add(event.idempotency_key);
      espiao.eventos.push({
        event_type: event.event_type,
        enrollment_id: event.enrollment_id,
        idempotency_key: event.idempotency_key,
        payload: event.payload,
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

  if (resultado !== null) {
    db.moverCardAoResponder = async (input) => {
      espiao.mudancas.push(input);
      return resultado;
    };
  }

  return { db, espiao };
}

/** O gatilho de etapa com a opção nova e/ou a antiga. */
function gatilhoDeEtapa(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "stage_change",
    params: { stage_id: ETAPA_ORCAMENTO },
    ...extra,
  };
}

function inscricao(over: Partial<LiveEnrollmentRef> = {}): LiveEnrollmentRef {
  return {
    id: "enr-1",
    status: "waiting_reply",
    current_node_id: "w1",
    steps_taken: 1,
    pointer_id: "ptr-1",
    handoff_policy: "pause",
    trigger_config: gatilhoDeEtapa({ move_to_stage_on_reply: ETAPA_NEGOCIACAO }),
    updated_at: "2026-11-01T12:00:00.000Z",
    ...over,
  };
}

function eventoDeInbound(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: null,
    payload: { contact_id: CONTATO, direction: "inbound", sent_at: AGORA },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: AGORA,
    ...over,
  } as EventRow;
}

describe("ao responder, mover o card para a etapa escolhida (#3974)", () => {
  it("a resposta do cliente move o card da etapa do gatilho para a etapa configurada", async () => {
    const { db, espiao } = montarDb([inscricao()]);

    await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(espiao.mudancas).toEqual([
      {
        organization_id: ORG,
        enrollment_id: "enr-1",
        contact_id: CONTATO,
        etapa_de_origem: ETAPA_ORCAMENTO,
        etapa_de_destino: ETAPA_NEGOCIACAO,
      },
    ]);
    // A trilha da inscrição diz POR QUE o card andou.
    expect(espiao.eventos.map((e) => e.event_type)).toContain("move_to_stage_on_reply");
  });

  it("vale também para a espera por tempo (`active`), não só para `waiting_reply`", async () => {
    const { db, espiao } = montarDb([inscricao({ status: "active" })]);

    await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(espiao.mudancas).toHaveLength(1);
  });

  it("sem a opção gravada, a resposta não move card nenhum", async () => {
    const { db, espiao } = montarDb([inscricao({ trigger_config: gatilhoDeEtapa() })]);

    await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(espiao.mudancas).toEqual([]);
    expect(espiao.eventos.map((e) => e.event_type)).not.toContain("move_to_stage_on_reply");
  });
});

describe("o lado oposto — o que a opção nova NÃO pode mudar (#3974)", () => {
  it("`cancelar ao responder` continua cancelando exatamente como antes", async () => {
    const { db, espiao } = montarDb([inscricao({ trigger_config: gatilhoDeEtapa({ cancel_on_reply: true }) })]);

    await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(espiao.patches).toHaveLength(1);
    expect(espiao.patches[0]!.patch).toMatchObject({
      status: "cancelled",
      outcome: "replied",
      cancel_reason: "cancel_on_reply",
    });
    expect(espiao.mudancas).toEqual([]);
  });

  it("com as DUAS opções ligadas, o card anda e a inscrição é cancelada", async () => {
    const { db, espiao } = montarDb([
      inscricao({ trigger_config: gatilhoDeEtapa({ cancel_on_reply: true, move_to_stage_on_reply: ETAPA_NEGOCIACAO }) }),
    ]);

    await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(espiao.mudancas).toHaveLength(1);
    expect(espiao.patches[0]!.patch).toMatchObject({ cancel_reason: "cancel_on_reply" });
  });

  it("contato sem negócio na etapa não quebra a automação e deixa o motivo na trilha", async () => {
    const { db, espiao } = montarDb([inscricao()], { resultado: { ok: false, motivo: "sem_negocio_na_etapa" } });

    const resumo = await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(resumo.matched).toBe(true);
    // Nada é cancelado — o que pode acontecer é o despertar da espera, que já
    // era o comportamento de sempre.
    expect(espiao.patches.some((p) => p.patch.status === "cancelled")).toBe(false);
    const falha = espiao.eventos.find((e) => e.event_type === "move_to_stage_on_reply_failed");
    expect(falha?.payload).toMatchObject({ motivo: "sem_negocio_na_etapa" });
  });

  it("etapa de destino recusada vira registro de falha, não silêncio", async () => {
    const { db, espiao } = montarDb([inscricao()], {
      resultado: { ok: false, motivo: "recusado", erro: "Etapa não encontrada" },
    });

    await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    const falha = espiao.eventos.find((e) => e.event_type === "move_to_stage_on_reply_failed");
    expect(falha?.payload).toMatchObject({ motivo: "recusado", erro: "Etapa não encontrada" });
  });

  it("re-drain do MESMO evento não move o card duas vezes", async () => {
    const evento = eventoDeInbound();
    const chave = `reactivity:${evento.id}:enr-1:move_to_stage`;

    const { db, espiao } = montarDb([inscricao()], { jaAplicadas: [chave] });

    await applyReactivityEvent(db, () => new Date(AGORA), evento);

    expect(espiao.mudancas).toEqual([]);
  });

  it("mensagem enviada pela EQUIPE não dispara nada", async () => {
    const { db, espiao } = montarDb([inscricao()]);

    const resumo = await applyReactivityEvent(
      db,
      () => new Date(AGORA),
      eventoDeInbound({ event_type: "message.sent" }),
    );

    expect(resumo.matched).toBe(false);
    expect(espiao.mudancas).toEqual([]);
  });

  it("mensagem recuperada de uma queda não PRODUZ efeito novo (o card não anda)", async () => {
    const { db, espiao } = montarDb([inscricao()]);

    await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound(), { semAcordar: true });

    expect(espiao.mudancas).toEqual([]);
  });

  it("gatilho que NÃO é de etapa não move card, mesmo com o campo gravado à mão", async () => {
    const { db, espiao } = montarDb([
      inscricao({ trigger_config: { kind: "manual", move_to_stage_on_reply: ETAPA_NEGOCIACAO } }),
    ]);

    await applyReactivityEvent(db, () => new Date(AGORA), eventoDeInbound());

    expect(espiao.mudancas).toEqual([]);
  });
});
