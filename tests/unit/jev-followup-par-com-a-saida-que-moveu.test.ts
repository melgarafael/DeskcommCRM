/**
 * O PAR DO JEV NO FOLLOW-UP É COM A SAÍDA QUE MOVEU O FLUXO.
 *
 * No passo "Classificar (IA)", o Jev observa ao lado da IA de sempre, e o par
 * vai para `jev_observacoes` (`lib/ai/decisao/followup.ts`). A linha é uma por
 * mensagem: a repetição do MESMO job só preenche o lado da IA quando ele
 * faltava. Até o conserto, o turno entregava a saída ao par ANTES de concluir o
 * passo: a 1ª tentativa classificava "quer", a conclusão caía, o retry
 * classificava de novo — um modelo não determinístico devolve "não quer" — e o
 * fluxo andava por "não quer" enquanto o par ficava com "quer". O cartão dizia
 * "puseram a resposta na mesma saída do fluxo" comparando o Jev com uma saída
 * que o fluxo nunca tomou.
 *
 * Aqui fica a ordem, no handler de produção (o que roda no `verify`). O
 * preenchimento só pelo mesmo job, com Postgres real, é
 * `tests/invariants/jev-followup-par-do-mesmo-job.test.ts`; o caminho inteiro,
 * `tests/invariants/jev-followup-no-turno.test.ts`.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as GetLeadContext from "@/lib/agent-engine/edge/crm/get-lead-context";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const getLeadContext = vi.fn();
const runModelCall = vi.fn();
const observar = vi.fn();

vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", async (original) => ({
  ...(await original<typeof GetLeadContext>()),
  getLeadContext,
}));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({ runModelCall }));
// O Jev é dublê: o que se mede é o que o turno entrega ao par, e quando.
vi.mock("@/lib/ai/decisao/followup", () => ({
  consultarJevNoFollowup: () => ({ escolha: Promise.resolve(null), observar }),
}));

const ORG = "org-1";
const LEAD = "lead-1";
const CONVERSA = "conversa-1";
const boundary = { organization_id: ORG, contact_id: LEAD, conversation_id: CONVERSA, service_revision: 1, demanda_id: null, demanda_revision: null };

const job = {
  id: "job-1",
  organization_id: ORG,
  contact_id: LEAD,
  kind: "followup_turn",
  source_event_id: null,
  payload: {
    service_boundary: boundary,
    followup_enrollment_id: "7d4f1c2a-0b1e-4c5d-9e8f-1a2b3c4d5e6f",
    node_id: "c1",
    purpose: "classify",
    classes: ["quer", "não quer"],
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

const pool = {
  query: vi.fn(async (sql: string) => {
    if (sql.includes("d.fechada_em::text")) return { rows: [{ ...boundary, status: "open", demanda_fechada_em: null }] };
    if (sql.includes("'action_sent'")) return { rows: [{ fechado_em: null }] };
    if (/from conversations c/.test(sql)) return { rows: [{ channel_session_id: "canal-1", archived_at: null }] };
    return { rows: [] };
  }),
} as never;

const ordem: string[] = [];
let conclusaoCai = false;
const complete = vi.fn(async (_pool: unknown, p: { result: unknown }) => {
  ordem.push(`concluir ${JSON.stringify(p.result)}`);
  if (conclusaoCai) throw new Error("conexão caiu ao concluir o passo");
});
let run: (job: JobRow, pool: never, ctx: { workerId: string }) => Promise<void>;

beforeAll(async () => {
  const { createFollowupTurnHandler } = await import("@/lib/agent-engine/agent/followup-turn");
  run = createFollowupTurnHandler({
    knobs: { historyLimit: 20, maxContextTokens: 4000 },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    completeFollowupTurn: complete,
  } as never);
}, 60_000);

beforeEach(() => {
  ordem.length = 0;
  conclusaoCai = false;
  complete.mockClear();
  observar.mockReset();
  observar.mockImplementation((classe: string | null) => ordem.push(`observar ${String(classe)}`));
  runModelCall.mockReset();
  // A resposta do cliente: sem envio do fluxo antes, vale a inbound que ninguém respondeu.
  getLeadContext.mockResolvedValue({
    ok: true,
    context: {
      contact: { is_blocked: false },
      conversation_id: CONVERSA,
      messages: [{ direction: "inbound", body: "quero sim", sent_at: "2026-09-26T10:05:00-03:00" }],
    },
  });
});

describe("o par do Jev no follow-up leva a saída que concluiu o passo", () => {
  it("a conclusão cai: o par fica SEM a saída desta tentativa — o retry, que pode escolher outra, é quem o completa", async () => {
    conclusaoCai = true;
    runModelCall.mockResolvedValue({ result: { text: '{"class": "quer"}' }, model: "m" });

    await expect(run(job, pool, { workerId: "w1" })).rejects.toThrow(/conexão caiu/);

    // Não-vacuidade: a IA de sempre classificou e o turno tentou concluir com a saída dela.
    expect(complete).toHaveBeenCalledTimes(1);
    expect(observar.mock.calls).toEqual([[null]]);
  });

  it("a conclusão passa: o par leva a saída DEPOIS de ela mover o fluxo", async () => {
    runModelCall.mockResolvedValue({ result: { text: '{"class": "não quer"}' }, model: "m" });

    await run(job, pool, { workerId: "w1" });

    expect(ordem).toEqual(['concluir {"kind":"classified","class":"não quer"}', "observar não quer"]);
  });

  it("a IA de sempre não classifica: nada é concluído, e o par fica sem ela (controle)", async () => {
    runModelCall.mockResolvedValue({ result: { text: "não sei" }, model: "m" });

    await expect(run(job, pool, { workerId: "w1" })).rejects.toThrow(/sem classe reconhecível/);

    expect(complete).not.toHaveBeenCalled();
    expect(observar.mock.calls).toEqual([[null]]);
  });
});
