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
 * - a varredura de silêncio não inscreve quem tem retorno VIVO nem quem tem um
 *   retorno que ACABOU DE SAIR (issue #2907 — a régua real, não um Set de mão),
 *   e inscreve os demais;
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
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  createSupabaseAdminClient,
  runFollowupTick,
  type AdminClient,
  type FollowupJobRequest,
} from "@/lib/followup/engine";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { folgaDepoisDoRetorno, reavaliarDepoisDoRetorno } from "@/lib/followup/retorno-segura-o-fluxo";
import { createSupabaseSilenceSweepDb, runSilenceSweep, type SilenceSweepDb } from "@/lib/followup/silence-sweep";

const AGORA = new Date("2026-09-25T15:00:00.000Z");
const RETORNO = "2026-09-30T12:00:00.000Z";

/**
 * Fake do PostgREST que responde `cron_jobs` por consulta — a régua real do
 * `createSupabaseSilenceSweepDb` roda em cima dele (o fake grava a cadeia e
 * devolve as linhas dadas; filtrar é trabalho do Postgres).
 */
function adminDeCronJobs(respostas: Array<Array<Record<string, unknown>>>) {
  let consultas = 0;
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          const rows = respostas[consultas++] ?? [];
          return (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
        }
        return () => chain;
      },
    },
  );
  return { admin: { from: () => chain } as unknown as SupabaseClient };
}

describe("varredura de silêncio", () => {
  function sweepDb(comRetorno: Set<string>) {
    const insert = vi.fn(async () => ({ inserted: true }));
    const db: SilenceSweepDb = {
      loadActiveSilencePointers: async () => [
        { id: "ptr", organization_id: "org", active_version_id: "v1", threshold_minutes: 60, segments: [] },
      ],
      loadSilentContactIds: async () => ["contato-com-retorno", "outro"],
      loadContatosComRetornoVivo: async () => comRetorno,
      loadEncerramentosDoFluxo: async () => new Map(),
      loadContatosComPessoaNoComando: async () => new Set<string>(),
      loadContatosComInscricaoViva: async () => new Set<string>(),
      loadContactIdsEmCooldown: async () => new Set<string>(),
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

  it("⭐ cada fluxo pergunta com a própria folga: 40 min → 4 h, 3 dias → 3 dias", async () => {
    for (const [gatilho, folga] of [
      [40, 4 * 3_600_000],
      [3 * 24 * 60, 72 * 3_600_000],
    ] as const) {
      const { db } = sweepDb(new Set());
      const pergunta = vi.fn(async (_org: string, _folgaMs: number) => new Set<string>());
      db.loadActiveSilencePointers = async () => [
        { id: "ptr", organization_id: "org", active_version_id: "v1", threshold_minutes: gatilho, segments: [] },
      ];
      db.loadContatosComRetornoVivo = pergunta;
      await runSilenceSweep({ db, gateDb, clock: () => AGORA });
      expect(pergunta).toHaveBeenCalledWith("org", folga);
    }
  });

  it("controle: sem retorno nenhum, os dois entram", async () => {
    const { db, insert } = sweepDb(new Set());
    await runSilenceSweep({ db, gateDb, clock: () => AGORA });
    expect(insert).toHaveBeenCalledTimes(2);
  });

  it("⭐ #2907: retorno JÁ EXECUTADO há 2 h também segura — a varredura não inscreve por cima", async () => {
    // A régua REAL (o adapter de produção sobre o PostgREST), e não um Set de mão:
    // o disparo one-shot deixa `enabled=false`, sem `cancelled_at`, sem
    // `last_error` e com `next_run_at` onde o retorno saiu. Antes do conserto a
    // varredura via este contato como simplesmente silencioso e o inscrevia no
    // minuto seguinte — medido em produção: retorno às 18:56:04, inscrição às
    // 18:56:00, "Follow-up 1" às 18:58:05.
    const { admin } = adminDeCronJobs([
      [], // nenhum retorno agendado (vivo)
      [{ contact_id: "contato-com-retorno", next_run_at: new Date(Date.now() - 2 * 3_600_000).toISOString() }],
    ]);
    const comRetorno = await createSupabaseSilenceSweepDb(admin).loadContatosComRetornoVivo("org", folgaDepoisDoRetorno(60));
    expect(comRetorno.has("contato-com-retorno")).toBe(true);

    const { db, insert } = sweepDb(comRetorno);
    const resumo = await runSilenceSweep({ db, gateDb, clock: () => AGORA });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ contact_id: "outro" }));
    expect(resumo.skipped_pending_return).toBe(1);
    expect(resumo.enrolled).toBe(1);
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
    const ate = reavaliarDepoisDoRetorno(RETORNO, 60);
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

  it("a regra devolve o gatilho do fluxo depois do retorno, nunca menos que 4 h", () => {
    const HORA = 3_600_000;
    const espera = (gatilhoMinutos: number) =>
      Date.parse(reavaliarDepoisDoRetorno(RETORNO, gatilhoMinutos)) - Date.parse(RETORNO);
    expect(espera(40)).toBe(4 * HORA); // o fluxo da #2907
    expect(espera(60)).toBe(4 * HORA);
    expect(espera(3 * 24 * 60)).toBe(72 * HORA);
  });

  it("⭐ o adaptador de produção lê o gatilho do fluxo da inscrição: fluxo de 3 dias segura 3 dias", async () => {
    // 1ª consulta: o retorno vivo mais tardio (cron_jobs); 2ª: o pointer da inscrição.
    const respostas: unknown[] = [
      [{ next_run_at: RETORNO }],
      { trigger_config: { kind: "silence", params: { threshold_minutes: 3 * 24 * 60 } } },
    ];
    let i = 0;
    const from = () => {
      const data = respostas[i++];
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve({ data, error: null });
            return () => chain;
          },
        },
      );
      return chain;
    };
    const db = createSupabaseAdminClient({ from } as unknown as SupabaseClient);
    const { enrollment } = loja(null);
    expect(await db.retornoQueSeguraOFluxo!(enrollment)).toBe("2026-10-03T12:00:00.000Z");
  });
});
