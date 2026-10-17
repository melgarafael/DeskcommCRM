/**
 * O CLASSIFICADOR DE SENTIMENTO NÃO RODA EM CANAL PAUSADO (#2436).
 *
 * Seguimento do #2433 (e do #2329): os efeitos INTERNOS de `message.received`
 * de um canal que o operador desligou, um a um — push, fluxo de follow-up,
 * gatilho de retorno, automação e `followup_turn`. Faltava o sexto consumidor:
 * `ai-sentiment-worker.v1` chamava `processSentiment` sem perguntar se o canal
 * está desativado, e a resposta é PAGA — com agente no ar, cada mensagem de um
 * canal pausado compra uma chamada de LLM e grava `sentiment_score` numa
 * conversa que a inbox nem mostra.
 *
 * O efeito para o cliente segue nenhum (o handoff que o sentimento baixo
 * dispararia já é barrado pela elegibilidade, `lib/ai/handoff/orchestrator.ts`),
 * mas custo de LLM e escrita em conversa escondida não passam: a MESMA régua
 * dos outros cinco consumidores, `canalDoEventoDesativado()`, no começo do
 * handler, devolvendo `skipped` / `canal_desativado`.
 *
 * O dublê AQUI confere os filtros — o `cadeiaDoCanal` do #2433 ignora `.eq`,
 * então tirar o `organization_id` da régua deixaria aquela suíte verde. Com
 * client service-role (bypassa RLS), o filtro de org é a única coisa entre a
 * leitura e a conversa de outra organização.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/workers/ai-sentiment-worker", () => ({ processSentiment: vi.fn() }));

// ─── O canal ────────────────────────────────────────────────────────────────
const canal = { desativado: true, leituraFalha: false };
/** `.eq` da consulta a `channel_sessions`, na ordem em que a régua os pediu. */
let eqDoCanal: Array<[string, unknown]> = [];
let idasAoCanal = 0;

/** Cadeia estreita o bastante pra régua, larga o bastante pra não travar. */
function cadeiaDoCanal() {
  idasAoCanal += 1;
  const self: Record<string, unknown> = {
    select: () => self,
    eq: (coluna: string, valor: unknown) => {
      eqDoCanal.push([coluna, valor]);
      return self;
    },
    maybeSingle: async () => {
      if (canal.leituraFalha) throw new Error("leitura falhou (dublê)");
      return {
        data: canal.desativado ? { metadata: { disabled: true } } : { metadata: {} },
        error: null,
      };
    },
  };
  return self;
}

/** Qualquer outra tabela: linha nula, para o caminho vermelho não explodir. */
function cadeiaQualquer() {
  const self: Record<string, unknown> = {
    select: () => self,
    eq: () => self,
    order: () => self,
    limit: () => self,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (ok: (v: unknown) => unknown) => ok({ data: [], error: null }),
  };
  return self;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    ({
      from: (tabela: string) => (tabela === "channel_sessions" ? cadeiaDoCanal() : cadeiaQualquer()),
    }) as never,
}));

import type { EventRow } from "@/lib/event-log/dispatcher";
import { processSentiment } from "@/workers/ai-sentiment-worker";
import { aiSentimentHandler } from "@/workers/ai-sentiment-worker.handler";

function evento(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "evt-1",
    organization_id: "org-1",
    event_type: "message.received",
    entity_kind: "message",
    entity_id: "msg-1",
    payload: {
      message_id: "msg-1",
      conversation_id: "conv-1",
      channel_session_id: "canal-1",
      body_preview: "oi",
    },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  };
}

beforeEach(() => {
  canal.desativado = true;
  canal.leituraFalha = false;
  eqDoCanal = [];
  idasAoCanal = 0;
  vi.clearAllMocks();
  vi.mocked(processSentiment).mockResolvedValue({ skipped: false, sentiment_score: 0.4 });
});

describe("consumidor 6 — classificador de sentimento", () => {
  it("canal pausado → skipped e NENHUMA chamada ao classificador sai", async () => {
    const r = await aiSentimentHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "canal_desativado" });
    expect(processSentiment).not.toHaveBeenCalled();
    expect(idasAoCanal, "a régua foi consultada uma vez só").toBe(1);
  });

  it("canal ligado → o classificador roda (a guarda não desligou o sentimento)", async () => {
    canal.desativado = false;
    const r = await aiSentimentHandler.handle(evento());
    expect(processSentiment).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "ok", detail: "0.4" });
  });

  it("leitura falha → abre, como a régua dos outros cinco consumidores", async () => {
    canal.leituraFalha = true;
    const r = await aiSentimentHandler.handle(evento());
    expect(processSentiment).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("ok");
  });

  it("sem channel_session_id no payload → nenhuma ida ao canal, o evento passa", async () => {
    const r = await aiSentimentHandler.handle(
      evento({ payload: { message_id: "msg-1", conversation_id: "conv-1" } }),
    );
    expect(idasAoCanal).toBe(0);
    expect(processSentiment).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("ok");
  });

  // O ponto cego do dublê do #2433: sem `.eq` registrado, a régua perder o
  // escopo de organização e a suíte continuava verde.
  it("a ida filtra organization_id e id — service-role não lê a conversa de outra org", async () => {
    await aiSentimentHandler.handle(evento());
    expect(eqDoCanal).toContainEqual(["organization_id", "org-1"]);
    expect(eqDoCanal).toContainEqual(["id", "canal-1"]);
  });
});
