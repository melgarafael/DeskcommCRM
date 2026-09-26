/**
 * O FLUXO DE SILÊNCIO NÃO FALA POR CIMA DE UM RETORNO AGENDADO.
 *
 * ## O defeito (medido numa instalação real, 25/09/2026)
 *
 * A cliente avisou que só compraria no dia 30, quando recebe o salário. O agente
 * agendou o retorno (`schedule_followup`) e respondeu "te escrevo no dia 30, sem
 * pressa". Uma hora depois o fluxo de silêncio a inscreveu de novo e mandou
 * pedido de dados; estavam na fila a oferta que ela já tinha aceitado (dia
 * seguinte) e a "última oportunidade" (dia 28). Nada ligava o retorno ao fluxo.
 *
 * ## O que este arquivo prende
 *
 * - a varredura de silêncio não inscreve quem tem retorno vivo (e inscreve os demais);
 * - a inscrição que já andava fica SEGURADA até a data que a regra devolve, com
 *   um evento legível no dossiê — sem enfileirar o envio;
 * - controle: sem retorno, o mesmo passo enfileira o envio.
 *
 * ## O que NÃO prova
 *
 * As consultas reais (`retorno-segura-o-fluxo.ts` sobre o PostgREST) — a régua da
 * consulta foi conferida contra um banco de produção ao escrever o conserto, e o
 * espelho em SQL puro mora no invariante da varredura (`test:db`).
 */
import { describe, expect, it, vi } from "vitest";

import { runFollowupTick, type AdminClient, type FollowupJobRequest } from "@/lib/followup/engine";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { FOLGA_DEPOIS_DO_RETORNO_MS, reavaliarDepoisDoRetorno } from "@/lib/followup/retorno-segura-o-fluxo";
import { runSilenceSweep, type SilenceSweepDb } from "@/lib/followup/silence-sweep";

const AGORA = new Date("2026-09-25T15:00:00.000Z");
const RETORNO = "2026-09-30T12:00:00.000Z";

describe("varredura de silêncio", () => {
  function sweepDb(comRetorno: Set<string>) {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db: SilenceSweepDb = {
      loadActiveSilencePointers: async () => [
        { id: "ptr", organization_id: "org", active_version_id: "v1", threshold_minutes: 60, segments: [] },
      ],
      loadSilentContactIds: async () => ["contato-com-retorno", "outro"],
      loadContatosComRetornoVivo: async () => comRetorno,
      loadTriggerNode: async () => ({ id: "inicio", pedeAgente: false }),
      insertEnrollment: insert,
    };
    return { db, insert };
  }
  const gateDb = { loadEnabledPublishedFollowupAgents: async () => [] };

  it("⭐ quem tem retorno agendado fica de fora; os demais silenciosos entram", async () => {
    const { db, insert } = sweepDb(new Set(["contato-com-retorno"]));
    const resumo = await runSilenceSweep({ db, gateDb, clock: () => AGORA });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "outro" }));
    expect(resumo.skipped_pending_return).toBe(1);
    expect(resumo.enrolled).toBe(1);
  });

  it("controle: sem retorno nenhum, os dois entram", async () => {
    const { db, insert } = sweepDb(new Set());
    await runSilenceSweep({ db, gateDb, clock: () => AGORA });
    expect(insert).toHaveBeenCalledTimes(2);
  });
});

describe("inscrição que já andava", () => {
  const GRAFO: FlowGraph = {
    nodes: [
      { id: "oferta", type: "action", label: "Oferta", position: { x: 0, y: 0 }, config: { mode: "text", body: "oi" } },
      { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
    ],
    edges: [{ id: "oferta-fim", source: "oferta", target: "fim", priority: 0, condition: { type: "always" } }],
  };

  function loja(seguraAte: string | null) {
    const enrollment: EnrollmentRow = {
      id: "enr-1",
      organization_id: "org",
      pointer_id: "ptr",
      version_id: "v1",
      contact_id: "contato-com-retorno",
      conversation_id: null,
      current_node_id: "oferta",
      status: "active",
      next_eval_at: AGORA.toISOString(),
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 3,
      outcome: null,
      cancel_reason: null,
      started_at: AGORA.toISOString(),
      completed_at: null,
      updated_at: AGORA.toISOString(),
    };
    const eventos: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
    const jobs: FollowupJobRequest[] = [];
    const db: AdminClient = {
      retornoQueSeguraOFluxo: async () => seguraAte,
      async claimDueEnrollments() {
        return enrollment.next_eval_at !== null && Date.parse(enrollment.next_eval_at) <= AGORA.getTime()
          ? [{ ...enrollment }]
          : [];
      },
      loadFlowGraph: async () => GRAFO,
      loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
      loadEnrollmentEvents: async () => [],
      loadLastInboundBody: async () => null,
      async insertEnrollmentEvent(e) {
        eventos.push({ event_type: e.event_type, payload: e.payload });
        return { inserted: true };
      },
      async updateEnrollment(_id, _org, patch) {
        Object.assign(enrollment, patch);
      },
      loadFlowPointerName: async () => "Remarketing",
      insertDeadInboxItem: async () => undefined,
      persistirRespostaFollowup: async () => undefined,
    };
    const tick = () => runFollowupTick({ db, clock: () => AGORA, enqueueJob: async (j) => void jobs.push(j) });
    return { enrollment, eventos, jobs, tick };
  }

  it("⭐ fica segurada até a data da regra: nada vai para a fila e o dossiê diz por quê", async () => {
    const ate = reavaliarDepoisDoRetorno(RETORNO);
    const l = loja(ate);
    await l.tick();

    expect(l.jobs).toHaveLength(0);
    expect(l.enrollment.next_eval_at).toBe(ate);
    expect(l.enrollment.current_node_id).toBe("oferta");
    expect(l.eventos.map((e) => e.event_type)).toEqual(["held_by_return"]);
  });

  it("controle: sem retorno, o mesmo passo enfileira o envio", async () => {
    const l = loja(null);
    await l.tick();
    expect(l.jobs).toHaveLength(1);
    expect(l.eventos.map((e) => e.event_type)).not.toContain("held_by_return");
  });

  it("a regra devolve um dia depois do retorno — o tempo de a pessoa responder", () => {
    expect(Date.parse(reavaliarDepoisDoRetorno(RETORNO)) - Date.parse(RETORNO)).toBe(FOLGA_DEPOIS_DO_RETORNO_MS);
    expect(FOLGA_DEPOIS_DO_RETORNO_MS).toBe(24 * 3_600_000);
  });
});
