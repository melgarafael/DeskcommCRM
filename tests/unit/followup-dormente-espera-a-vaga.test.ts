/**
 * A INSCRIÇÃO DORMENTE QUE ACORDA COM A VAGA TOMADA ADIA — E VOLTA.
 *
 * ## O defeito, medido numa instalação real (19–20/10/2026)
 *
 * 1. O fluxo A inscreve o contato e chega a uma espera `fixed` com
 *    `immune_to_reply` — a inscrição vai para `dormente`, que por construção NÃO
 *    ocupa a vaga de `idx_followup_enrollments_one_live`.
 * 2. 43 min depois a etapa muda e o fluxo B inscreve o mesmo contato. Correto:
 *    a vaga estava livre.
 * 3. No dia seguinte A acorda; o `advance` grava `status: 'active'`, o índice
 *    recusa (23505), o motor tratava como falha comum, repetia com backoff e
 *    marcava `dead` com o aviso de INCIDENTE "Um fluxo de follow-up parou de
 *    tentar … duplicate key" na Central. O contato estava bem servido por B.
 *
 * ## O que fica preso aqui
 *
 * - a dormente ADIA: continua `dormente`, volta a tentar em 1 h, sem gastar
 *   tentativa, sem mexer no `last_error` e sem item na Central;
 * - a trilha registra a espera UMA vez (a chave é a trava) e o `desde` dela é
 *   o COMEÇO da espera, não a hora do último adiamento;
 * - depois de adiar, com a vaga livre, a MESMA inscrição retoma e avança — sem
 *   repetir o evento de avanço;
 * - duas dormentes do mesmo contato no mesmo tick: uma avança, a outra adia, e
 *   nenhuma vira `cancelled` nem `dead`;
 * - depois de 7 dias esperando, a inscrição desiste COM aviso na Central;
 * - a MESMA recusa numa inscrição que já estava viva continua falha (é corrida);
 * - só o 23505 do índice de vaga vira o erro tipado.
 *
 * ## O que NÃO prova
 *
 * Nada com Postgres real: que o `fn_followup_patch` devolve o 23505 com o nome
 * do índice na mensagem foi medido no `last_error` gravado em produção, e o
 * limite de 7 dias é medido no relógio do motor — o banco só guarda a data do
 * próximo adiamento.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";
import {
  INTERVALO_DA_VAGA_OCUPADA_MS,
  LIMITE_DA_VAGA_OCUPADA_MS,
  MOTIVO_DA_VAGA_OCUPADA_DEMAIS,
  VagaDoContatoOcupadaError,
  erroDoPatch,
  runFollowupTick,
  type AdminClient,
} from "@/lib/followup/engine";
import { descreveEvento } from "@/lib/followup/eventos-legiveis";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";

const AGORA = new Date("2026-10-20T16:37:00.000Z");
const DIA_MS = 24 * 60 * 60 * 1000;
/** Os status que ocupam a vaga — é o `where status in (...)` do índice do banco. */
const STATUS_QUE_OCUPAM_VAGA = new Set(["active", "waiting_reply", "paused_handoff"]);
const RECUSA_DO_INDICE = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "idx_followup_enrollments_one_live"',
};

const GRAFO: FlowGraph = {
  nodes: [
    {
      id: "espera",
      type: "wait",
      label: "Aguardar 1 dia",
      position: { x: 0, y: 0 },
      config: { mode: "fixed", duration_ms: 86_400_000, immune_to_reply: true },
    },
    { id: "fim", type: "end", label: "Fim", position: { x: 0, y: 0 }, config: { outcome: "exhausted" } },
  ],
  edges: [{ id: "espera-fim", source: "espera", target: "fim", priority: 0, condition: { type: "always" } }],
};

interface EventoDaTrilha {
  enrollment_id: string;
  node_id: string | null;
  idempotency_key: string | null;
  event_type: string;
  payload: Record<string, unknown>;
}

function inscricaoDe(id: string, status: EnrollmentRow["status"], maxAttempts: number): EnrollmentRow {
  return {
    id,
    organization_id: "org",
    pointer_id: "ptr",
    version_id: "v1",
    contact_id: "contato-1",
    conversation_id: null,
    current_node_id: "espera",
    status,
    next_eval_at: AGORA.toISOString(),
    claimed_until: null,
    attempts: 0,
    max_attempts: maxAttempts,
    last_error: null,
    steps_taken: 3,
    outcome: null,
    cancel_reason: null,
    started_at: AGORA.toISOString(),
    completed_at: null,
    updated_at: AGORA.toISOString(),
  };
}

/**
 * O dublê do `AdminClient`, com o relógio e a vaga do contato no controle do
 * teste — é o que permite medir a espera que passa.
 */
function loja(opts: {
  /** O status com que a inscrição DORME. */
  status?: EnrollmentRow["status"];
  maxAttempts?: number;
  /** Quantas inscrições do MESMO contato o tick carrega. */
  quantas?: number;
  /** Quem ocupa a vaga do contato: `null` = livre, `"outro"` = outro fluxo. */
  vaga?: string | null;
} = {}) {
  let agora = AGORA;
  let vaga = opts.vaga === undefined ? "outro" : opts.vaga;
  const status = opts.status ?? "dormente";
  const inscricoes: EnrollmentRow[] = Array.from(
    { length: opts.quantas ?? 1 },
    (_, i) => inscricaoDe(`enr-${i + 1}`, status, opts.maxAttempts ?? 5),
  );
  // A espera já começou no passo anterior: é o que faz o nó `wait` dar a espera
  // por vencida, e é o que o motor usa para saber que ela VENCEU.
  const trilha: EventoDaTrilha[] = inscricoes.map((e) => ({
    enrollment_id: e.id,
    node_id: "espera",
    idempotency_key: "espera:2",
    event_type: "wait_started",
    payload: {},
  }));
  const avisos = vi.fn(
    async (_item: { organization_id: string; title: string; body: string; ref_id: string }) => undefined,
  );
  const db: AdminClient = {
    async claimDueEnrollments() {
      return inscricoes
        .filter((e) => e.next_eval_at !== null && Date.parse(e.next_eval_at) <= agora.getTime())
        .map((e) => ({ ...e }));
    },
    loadFlowGraph: async () => GRAFO,
    loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
    loadEnrollmentEvents: async (id) =>
      trilha
        .filter((e) => e.enrollment_id === id)
        .map((e) => ({
          node_id: e.node_id,
          idempotency_key: e.idempotency_key,
          event_type: e.event_type,
          payload: e.payload,
        })),
    loadLastInboundBody: async () => null,
    async insertEnrollmentEvent(e) {
      // A chave é a trava do banco (`idx_followup_events_idem`): o insert
      // repetido é ignorado, e o motor lê isso como "replay".
      if (
        trilha.some(
          (x) => x.enrollment_id === e.enrollment_id && x.idempotency_key === e.idempotency_key,
        )
      ) {
        return { inserted: false };
      }
      trilha.push({
        enrollment_id: e.enrollment_id,
        node_id: e.node_id,
        idempotency_key: e.idempotency_key,
        event_type: e.event_type,
        payload: e.payload,
      });
      return { inserted: true };
    },
    async updateEnrollment(id, _org, patch) {
      // O que o `fn_followup_patch` faz: recusa levar a inscrição a um status que
      // ocupa vaga quando outra inscrição do contato já ocupa a dela.
      if (patch.status !== undefined && STATUS_QUE_OCUPAM_VAGA.has(patch.status)) {
        if (vaga !== null && vaga !== id) throw erroDoPatch(RECUSA_DO_INDICE);
        vaga = id;
      }
      Object.assign(inscricoes.find((e) => e.id === id)!, patch);
    },
    loadFlowPointerName: async () => "Prospecção · abordagem por IA",
    insertDeadInboxItem: avisos,
    persistirRespostaFollowup: async () => undefined,
  };
  const tick = () => runFollowupTick({ db, clock: () => agora, enqueueJob: async () => undefined });
  return {
    inscricoes,
    trilha,
    avisos,
    tick,
    inscricao: (id = "enr-1") => inscricoes.find((e) => e.id === id)!,
    eventosDe: (id = "enr-1") => trilha.filter((e) => e.enrollment_id === id),
    eventosDoTipo: (eventType: string, id = "enr-1") =>
      trilha.filter((e) => e.enrollment_id === id && e.event_type === eventType),
    /** Leva o relógio adiante — o adiamento só acontece quando o tempo passa. */
    passarPara: (ms: number) => {
      agora = new Date(agora.getTime() + ms);
    },
    /** O outro acompanhamento termina: a vaga do contato fica livre. */
    liberarVaga: () => {
      vaga = null;
    },
    /** Semeia a espera que já está na trilha (o `desde` de um adiamento antigo). */
    semearEspera: (desdeISO: string, id = "enr-1") => {
      trilha.push({
        enrollment_id: id,
        node_id: "espera",
        idempotency_key: "espera:3:vaga_ocupada",
        event_type: "waiting_for_taken_slot",
        payload: { desde: desdeISO, reavaliar_em: desdeISO },
      });
    },
  };
}

describe("a dormente acorda e encontra outro fluxo no contato", () => {
  it("⭐ adia: continua dormente, volta a tentar em 1 h, sem gastar tentativa e sem aviso na Central", async () => {
    const l = loja({ status: "dormente" });
    await l.tick();

    const e = l.inscricao();
    expect(e.status).toBe("dormente");
    expect(e.next_eval_at).toBe(
      new Date(AGORA.getTime() + INTERVALO_DA_VAGA_OCUPADA_MS).toISOString(),
    );
    expect(e.attempts).toBe(0);
    expect(e.last_error).toBeNull();
    expect(e.cancel_reason).toBeNull();
    expect(e.completed_at).toBeNull();
    expect(l.avisos).not.toHaveBeenCalled();

    const esperas = l.eventosDoTipo("waiting_for_taken_slot");
    expect(esperas).toHaveLength(1);
    expect(esperas[0]!.payload.desde).toBe(AGORA.toISOString());
    expect(esperas[0]!.payload.reavaliar_em).toBe(
      new Date(AGORA.getTime() + INTERVALO_DA_VAGA_OCUPADA_MS).toISOString(),
    );
  });

  it("⭐ com as tentativas no limite, continua adiando (o desfecho medido era `dead`)", async () => {
    // `max_attempts: 0` põe a PRIMEIRA falha no `markDead` — o caminho antigo
    // abriria aqui o aviso "Um fluxo de follow-up parou de tentar".
    const l = loja({ status: "dormente", maxAttempts: 0 });
    await l.tick();

    expect(l.inscricao().status).toBe("dormente");
    expect(l.inscricao().attempts).toBe(0);
    expect(l.avisos).not.toHaveBeenCalled();
  });

  it("adiar de novo não repete o evento, e o `desde` do primeiro continua valendo", async () => {
    const l = loja({ status: "dormente" });
    await l.tick();
    const primeiro = l.eventosDoTipo("waiting_for_taken_slot")[0]!;

    l.passarPara(INTERVALO_DA_VAGA_OCUPADA_MS);
    await l.tick();

    const esperas = l.eventosDoTipo("waiting_for_taken_slot");
    expect(esperas).toHaveLength(1);
    expect(esperas[0]!.payload.desde).toBe(primeiro.payload.desde);
    expect(l.inscricao().status).toBe("dormente");
    expect(l.inscricao().next_eval_at).toBe(
      new Date(AGORA.getTime() + 2 * INTERVALO_DA_VAGA_OCUPADA_MS).toISOString(),
    );
    expect(l.avisos).not.toHaveBeenCalled();
  });

  it("⭐ com a vaga livre, a MESMA inscrição retoma e avança (sem repetir o evento de avanço)", async () => {
    const l = loja({ status: "dormente" });
    await l.tick();
    expect(l.inscricao().status).toBe("dormente");

    // O outro acompanhamento termina; a inscrição volta a ser devida.
    l.liberarVaga();
    l.passarPara(INTERVALO_DA_VAGA_OCUPADA_MS);
    await l.tick();

    const e = l.inscricao();
    expect(e.current_node_id).toBe("fim");
    expect(e.status).toBe("active");
    expect(e.cancel_reason).toBeNull();
    // O `node_advanced` do passo JÁ estava gravado do tick que adiou — a
    // retomada passa pelo replay, e não repete o avanço.
    expect(l.eventosDoTipo("node_advanced")).toHaveLength(1);
    expect(l.eventosDoTipo("waiting_for_taken_slot")).toHaveLength(1);
    expect(l.avisos).not.toHaveBeenCalled();
  });

  it("duas dormentes do MESMO contato no mesmo tick: uma avança, a outra adia, e nenhuma morre", async () => {
    const l = loja({ status: "dormente", quantas: 2, vaga: null });
    await l.tick();

    const [primeira, segunda] = l.inscricoes;
    expect(primeira!.status).toBe("active");
    expect(primeira!.current_node_id).toBe("fim");
    expect(segunda!.status).toBe("dormente");
    expect(segunda!.next_eval_at).toBe(
      new Date(AGORA.getTime() + INTERVALO_DA_VAGA_OCUPADA_MS).toISOString(),
    );

    for (const e of l.inscricoes) {
      expect(e.status).not.toBe("cancelled");
      expect(e.status).not.toBe("dead");
      expect(e.cancel_reason).toBeNull();
      expect(e.completed_at).toBeNull();
    }
    expect(l.eventosDoTipo("waiting_for_taken_slot", "enr-2")).toHaveLength(1);
    expect(l.eventosDoTipo("waiting_for_taken_slot", "enr-1")).toHaveLength(0);
    expect(l.avisos).not.toHaveBeenCalled();
  });

  it("⭐ depois de 7 dias esperando, desiste COM aviso na Central", async () => {
    const l = loja({ status: "dormente" });
    l.semearEspera(new Date(AGORA.getTime() - 8 * DIA_MS).toISOString());
    await l.tick();

    const e = l.inscricao();
    expect(e.status).toBe("cancelled");
    expect(e.cancel_reason).toBe(MOTIVO_DA_VAGA_OCUPADA_DEMAIS);
    expect(e.next_eval_at).toBeNull();
    expect(e.completed_at).toBe(AGORA.toISOString());

    expect(l.avisos).toHaveBeenCalledTimes(1);
    const aviso = l.avisos.mock.calls[0]![0];
    expect(aviso.title).toBe("Um retorno programado não pôde ser enviado");
    expect(aviso.body).toContain("Prospecção · abordagem por IA");
    expect(aviso.body).toContain("esperou 7 dias");
    expect(aviso.body).toContain("enrollment enr-1");
    expect(aviso.body).toContain("Fale com o contato por outro caminho");

    expect(l.eventosDoTipo("gave_up_taken_slot")).toHaveLength(1);
    // A espera não foi repetida: a trilha tem UM registro do começo da espera.
    expect(l.eventosDoTipo("waiting_for_taken_slot")).toHaveLength(1);
  });

  it("a fronteira do limite é o limite: um minuto antes, ainda adia", async () => {
    const quase = loja({ status: "dormente" });
    quase.semearEspera(
      new Date(AGORA.getTime() - (LIMITE_DA_VAGA_OCUPADA_MS - 60_000)).toISOString(),
    );
    await quase.tick();

    expect(quase.inscricao().status).toBe("dormente");
    expect(quase.inscricao().cancel_reason).toBeNull();
    expect(quase.avisos).not.toHaveBeenCalled();

    const noLimite = loja({ status: "dormente" });
    noLimite.semearEspera(
      new Date(AGORA.getTime() - LIMITE_DA_VAGA_OCUPADA_MS).toISOString(),
    );
    await noLimite.tick();

    expect(noLimite.inscricao().status).toBe("cancelled");
    expect(noLimite.inscricao().cancel_reason).toBe(MOTIVO_DA_VAGA_OCUPADA_DEMAIS);
    expect(noLimite.avisos).toHaveBeenCalledTimes(1);
  });

  it("a mesma recusa numa inscrição que JÁ estava viva continua falha com retentativa", async () => {
    const l = loja({ status: "active" });
    await l.tick();

    const e = l.inscricao();
    expect(e.status).toBe("active");
    expect(e.attempts).toBe(1);
    expect(e.cancel_reason).toBeNull();
    expect(l.eventosDoTipo("waiting_for_taken_slot")).toHaveLength(0);
  });
});

describe("só a recusa do índice de vaga vira o erro tipado", () => {
  it("23505 em idx_followup_enrollments_one_live → VagaDoContatoOcupadaError", () => {
    expect(erroDoPatch(RECUSA_DO_INDICE)).toBeInstanceOf(VagaDoContatoOcupadaError);
  });

  it("23505 de OUTRO índice continua erro comum", () => {
    const e = erroDoPatch({ code: "23505", message: 'duplicate key value violates unique constraint "outro_indice"' });
    expect(e).not.toBeInstanceOf(VagaDoContatoOcupadaError);
    expect(e.message).toContain("outro_indice");
  });

  it("erro sem código continua erro comum, com a mensagem original", () => {
    const e = erroDoPatch({ message: "connection reset" });
    expect(e).not.toBeInstanceOf(VagaDoContatoOcupadaError);
    expect(e.message).toBe("connection reset");
  });
});

describe("a trilha do acompanhamento diz o que está acontecendo", () => {
  it("os dois eventos novos têm frase própria, em português, espanhol e inglês", () => {
    const en = JSON.parse(readFileSync("lib/i18n/traducoes/en.json", "utf8")) as Record<string, string>;
    for (const eventType of ["waiting_for_taken_slot", "gave_up_taken_slot"]) {
      const r = descreveEvento(
        { id: "e1", node_id: "espera", event_type: eventType, payload: {}, created_at: AGORA.toISOString() },
        {},
        "pt-BR",
      );
      expect(r.titulo).toBeTruthy();
      expect(r.detalhe).toBeTruthy();
      for (const frase of [r.titulo, r.detalhe ?? ""]) {
        expect(DICIONARIO[frase]?.es, `sem espanhol: ${frase}`).toBeTruthy();
        expect(en[frase], `sem inglês: ${frase}`).toBeTruthy();
      }
    }
  });

  it("a espera diz que tenta de novo a cada hora, por até 7 dias", () => {
    const r = descreveEvento(
      { id: "e1", node_id: "espera", event_type: "waiting_for_taken_slot", payload: {}, created_at: AGORA.toISOString() },
      {},
      "pt-BR",
    );
    expect(r.titulo).toBe("Esperando o outro acompanhamento deste contato terminar");
    expect(r.detalhe).toBe("tenta de novo a cada hora, por até 7 dias");
  });

  it("a desistência diz que o outro acompanhamento ocupou o contato por 7 dias", () => {
    const r = descreveEvento(
      { id: "e1", node_id: "espera", event_type: "gave_up_taken_slot", payload: {}, created_at: AGORA.toISOString() },
      {},
      "pt-BR",
    );
    expect(r.titulo).toBe("Cancelado: outro acompanhamento ocupou o contato por 7 dias");
  });
});

describe("o motivo do cancelamento sai no idioma de quem lê", () => {
  it("o motivo gravado tem tradução em espanhol e inglês", () => {
    const en = JSON.parse(readFileSync("lib/i18n/traducoes/en.json", "utf8")) as Record<string, string>;
    expect(DICIONARIO[MOTIVO_DA_VAGA_OCUPADA_DEMAIS]?.es, "sem espanhol").toBeTruthy();
    expect(en[MOTIVO_DA_VAGA_OCUPADA_DEMAIS], "sem inglês").toBeTruthy();
  });

  it("a tela do acompanhamento passa o motivo pelo tradutor, e não o mostra cru", () => {
    const fonte = readFileSync("app/app/ai/followups/enrollments/[id]/_components/DossieDoFollowup.tsx", "utf8");
    expect(fonte).toMatch(/\{t\("Motivo"\)\}: \{t\(data\.cancel_reason\)\}/);
  });
});
