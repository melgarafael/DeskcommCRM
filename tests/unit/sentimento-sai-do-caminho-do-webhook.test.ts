/**
 * O SENTIMENTO SAI DO CAMINHO DO WEBHOOK, SEM PERDER O EVENTO.
 *
 * `acelerarPipelineDeEventos` (lib/dev/kick-local-pipeline.ts) drena o
 * `event_log` DENTRO do webhook de mensagem, marcado por `comOrigemDeRequest`,
 * e isso acontece antes de o despacho do agente ser emitido
 * (lib/channels/pos-entrada.ts). O sentimento chama um modelo a cada mensagem:
 * ali, a latência dele somava ao tempo de resposta do webhook (que tem timeout
 * e reentrega) e ao tempo até o agente começar a pensar.
 *
 * O handler agora se adia como os avisos de caso e de proposta. O que este
 * arquivo prova é o CONTRATO do adiamento pelo dreno de verdade
 * (`drainEventLog` + `dispatchEvent`), não só o retorno do handler:
 *  - dentro do webhook, o modelo não é chamado; a linha fica `pending`, sem
 *    contar tentativa, e o outro consumidor da mesma mensagem já entra em
 *    `consumed_by` (não roda de novo);
 *  - o adiamento põe `next_attempt_at` no futuro: o webhook SEGUINTE não
 *    reivindica a linha de novo (com "agora", cada inbound a regravava e, numa
 *    rajada, as adiadas ocupavam o lote do dreno do webhook);
 *  - vencido o prazo, o dreno de fora do webhook (o laço do worker) roda só o
 *    sentimento e fecha a linha.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/workers/ai-sentiment-worker", () => ({ processSentiment: vi.fn() }));

import { registerHandler, type EventHandler } from "@/lib/event-log/dispatcher";
import { drainEventLog } from "@/lib/event-log/drain";
import { ADIAMENTO_DO_DRENO_EM_REQUEST_MS } from "@/lib/escalacao/aviso-ao-suporte";
import { comOrigemDeRequest } from "@/lib/event-log/origem-do-dreno";
import { processSentiment } from "@/workers/ai-sentiment-worker";
import { AI_SENTIMENT_HANDLER_KEY, aiSentimentHandler } from "@/workers/ai-sentiment-worker.handler";

const ORG = "11111111-1111-4111-8111-111111111111";

type Linha = Record<string, unknown>;

/**
 * `event_log` em memória com a semântica que o dreno usa: `eq`, o `or` de
 * `next_attempt_at`, `lt` dos presos, e o `update` que só toca o que casa.
 */
function fazerAdmin(eventos: Linha[]) {
  const from = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let mudanca: Linha | null = null;
    const casam = () => (tabela === "event_log" ? eventos : []).filter((l) => filtros.every((f) => f(l)));
    const resolver = () => {
      if (tabela === "organizations") return { data: [{ id: ORG, status: "active" }], error: null };
      const ls = casam();
      if (mudanca) for (const l of ls) Object.assign(l, mudanca);
      return { data: ls.map((l) => (mudanca ? { id: l.id } : { ...l })), error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = {
      select: () => c,
      update: (m: Linha) => ((mudanca = m), c),
      eq: (col: string, v: unknown) => (filtros.push((l) => l[col] === v), c),
      lt: (col: string, v: string) => (filtros.push((l) => String(l[col]) < v), c),
      in: (col: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[col])), c),
      or: (expr: string) => {
        const agora = expr.split("next_attempt_at.lte.")[1]!;
        filtros.push((l) => l.next_attempt_at == null || String(l.next_attempt_at) <= agora);
        return c;
      },
      order: () => c,
      limit: () => c,
      then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(resolver()).then(ok, falha),
    };
    return c;
  };
  return { from } as never;
}

const outro = vi.fn(async () => ({ consumer_key: "outro-consumidor.v1", status: "ok" as const }));
const outroHandler: EventHandler = {
  key: "outro-consumidor.v1",
  naOrgParada: "roda",
  events: ["message.received"],
  handle: outro,
};

registerHandler(outroHandler);
registerHandler(aiSentimentHandler);

function evento(): Linha {
  return {
    id: "e1",
    organization_id: ORG,
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "m1",
    payload: { message_id: "m1", conversation_id: "c1" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    status: "pending",
    next_attempt_at: null,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processSentiment).mockResolvedValue({ skipped: false, sentiment_score: 0.8 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sentimento no dreno de dentro do webhook", () => {
  it("adia sem chamar o modelo, sem contar tentativa e sem perder o evento", async () => {
    const eventos = [evento()];

    const resumo = await comOrigemDeRequest(() => drainEventLog(fazerAdmin(eventos)));

    expect(processSentiment, "o modelo rodou dentro do webhook").not.toHaveBeenCalled();
    expect(outro).toHaveBeenCalledTimes(1);
    expect(resumo.retried).toBe(1);
    const [linha] = eventos;
    expect(linha).toMatchObject({ status: "pending", attempts: 0, consumed_by: ["outro-consumidor.v1"] });
    expect(
      Date.parse(String(linha!.next_attempt_at)),
      "a linha adiada ficou vencida: o próximo webhook a reivindica de novo",
    ).toBeGreaterThan(Date.now());
  });

  it("o webhook seguinte não reivindica de novo a linha adiada", async () => {
    const eventos = [evento()];
    await comOrigemDeRequest(() => drainEventLog(fazerAdmin(eventos)));
    const adiadaPara = eventos[0]!.next_attempt_at;

    const resumo = await comOrigemDeRequest(() => drainEventLog(fazerAdmin(eventos)));

    expect(resumo.scanned, "o segundo webhook pegou a linha que o primeiro adiou").toBe(0);
    expect(outro).toHaveBeenCalledTimes(1);
    expect(eventos[0]!.next_attempt_at, "a linha foi regravada pelo segundo webhook").toBe(adiadaPara);
  });

  it("vencido o adiamento, o dreno de fora do webhook roda só o sentimento e fecha a linha", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const eventos = [evento()];
    await comOrigemDeRequest(() => drainEventLog(fazerAdmin(eventos)));

    vi.setSystemTime(Date.now() + ADIAMENTO_DO_DRENO_EM_REQUEST_MS);
    const resumo = await drainEventLog(fazerAdmin(eventos));

    expect(processSentiment).toHaveBeenCalledTimes(1);
    expect(outro, "o outro consumidor rodou duas vezes para a mesma mensagem").toHaveBeenCalledTimes(1);
    expect(resumo.done).toBe(1);
    expect(eventos[0]).toMatchObject({
      status: "done",
      consumed_by: ["outro-consumidor.v1", AI_SENTIMENT_HANDLER_KEY],
    });
  });
});
