/**
 * O TURNO DE RETOMADA confere de novo antes de falar.
 *
 * Entre o consumidor de `ai.handoff_resolved` enfileirar (lib/escalacao/
 * retomada-ao-devolver.ts) e o worker reclamar o job, o cliente pode ter
 * escrito, a IA pode ter falado ou um follow-up pode ter nascido. Em qualquer
 * desses casos, falar por cima é o defeito que a opção existe para evitar.
 *
 * Prende:
 * - última fala ainda da equipe e nenhum follow-up vivo ⇒ o núcleo do agente
 *   roda com a abertura de RETOMADA (as falas da equipe na íntegra), não a de
 *   follow-up agendado;
 * - cliente escreveu / IA falou / follow-up vivo ⇒ o núcleo NÃO roda.
 *
 * NÃO prova: nada com Postgres real; os portões do núcleo (handoff, janela,
 * before-send) têm os testes deles e aqui o núcleo é dublê.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobRow } from "@/lib/agent-engine/queue/queue";

vi.mock("@/lib/agent-engine/agent/human-handoff", () => ({
  isLeadInHandoff: vi.fn(async () => false),
}));

type Abertura = (ritual: Record<string, unknown>) => string;
const runAgentTurn = vi.fn(
  async (_d: unknown, _j: unknown, _p: unknown, _c: unknown, _i: { buildOpening: Abertura }) => undefined,
);
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => ({
  ...(await original<typeof import("@/lib/agent-engine/agent/inbound-turn")>()),
  runAgentTurn,
}));

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const CANAL = "canal-1";

const boundary = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

function job(): JobRow {
  return {
    id: "job-1",
    organization_id: ORG,
    contact_id: LEAD,
    kind: "followup_turn",
    source_event_id: "evento-1",
    payload: {
      mode: "retomada",
      reason: "a equipe devolveu o atendimento ao agente",
      conversation_id: CONVERSA,
      channel_session_id: CANAL,
      service_boundary: boundary,
    },
    status: "running",
    priority: 0,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 3,
    last_error: null,
    locked_by: "w1",
    locked_at: new Date(),
    created_at: new Date(),
  } as JobRow;
}

interface Linha {
  direction: string;
  sent_via: string | null;
  type?: string;
  body: string | null;
}

function fakePool(c: { mensagens: Linha[]; vivo?: boolean }) {
  const query = vi.fn(async (sql: string): Promise<{ rows: Array<Record<string, unknown>> }> => {
    if (sql.includes("d.fechada_em::text"))
      return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (/from conversations/.test(sql))
      return { rows: [{ id: CONVERSA, channel_session_id: CANAL, archived_at: null }] };
    if (/from messages/.test(sql))
      return {
        rows: c.mensagens.map((m) => ({
          type: "text",
          media_url: null,
          media_storage_path: null,
          media_derived_text: null,
          ...m,
        })),
      };
    if (/from followup_enrollments/.test(sql)) return { rows: c.vivo ? [{ id: "inscricao-viva" }] : [] };
    return { rows: [] };
  });
  return { query } as never;
}

const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  crmCfg: {},
  llmCfg: {},
  knobs: {},
} as never;

let criarHandler: typeof import("@/lib/agent-engine/agent/followup-turn").createFollowupTurnHandler;

beforeAll(async () => {
  ({ createFollowupTurnHandler: criarHandler } = await import("@/lib/agent-engine/agent/followup-turn"));
}, 60_000);

beforeEach(() => runAgentTurn.mockClear());

/** Mais nova primeiro — a ordem da consulta. */
const EQUIPE_POR_ULTIMO: Linha[] = [
  { direction: "outbound", sent_via: "crm", body: "Segue o orçamento: R$ 4.800 com instalação." },
  { direction: "outbound", sent_via: "external_device", body: "Oi! Acabei de medir aqui." },
  { direction: "inbound", sent_via: null, body: "quero falar com um atendente" },
];

describe("turno de retomada: fala só se a última fala ainda for da equipe", () => {
  it("equipe por último e sem follow-up vivo: roda o núcleo com a abertura de retomada", async () => {
    await criarHandler(deps)(job(), fakePool({ mensagens: EQUIPE_POR_ULTIMO }), { workerId: "w1" });

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const input = runAgentTurn.mock.calls[0]![4];
    const abertura = input.buildOpening({
      previous: null,
      leadState: null,
      context: { contact: {}, messages: [] },
      notesIndexBlock: "",
      projeta: false,
    });
    expect(abertura).toContain("acabou de devolver o atendimento a você");
    // As falas da equipe, na íntegra e em ordem cronológica.
    expect(abertura.indexOf("Acabei de medir aqui")).toBeLessThan(abertura.indexOf("R$ 4.800"));
    // A fala do cliente que causou a passagem NÃO vira "o que a equipe enviou".
    expect(abertura).not.toContain("quero falar com um atendente");
    // E nunca a abertura de follow-up agendado, que contaria a história errada.
    expect(abertura).not.toContain("Follow-up agendado");
  });

  it("o cliente escreveu depois da equipe: não roda (o turno de resposta responde)", async () => {
    await criarHandler(deps)(
      job(),
      fakePool({ mensagens: [{ direction: "inbound", sent_via: null, body: "recebi, obrigado" }, ...EQUIPE_POR_ULTIMO] }),
      { workerId: "w1" },
    );
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("a IA já falou depois da equipe: não roda", async () => {
    await criarHandler(deps)(
      job(),
      fakePool({ mensagens: [{ direction: "outbound", sent_via: "ai", body: "Recebeu o orçamento?" }, ...EQUIPE_POR_ULTIMO] }),
      { workerId: "w1" },
    );
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("nasceu follow-up vivo para o contato: não roda (uma voz só)", async () => {
    await criarHandler(deps)(job(), fakePool({ mensagens: EQUIPE_POR_ULTIMO, vivo: true }), { workerId: "w1" });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
