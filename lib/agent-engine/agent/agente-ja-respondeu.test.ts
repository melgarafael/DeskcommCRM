/**
 * A ÂNCORA DO "JÁ RESPONDEU" — a fiação da consulta (#3142).
 *
 * O comportamento ponta a ponta (o turno REAL que cala ou segue) está em
 * `tests/unit/filtro-de-palavra-chave-no-turno.test.ts`. Aqui se prova o que
 * aquele teste não enxerga: QUEM é perguntado — os parâmetros que a consulta
 * manda (org, conversa e o `ai_agents.id` do agente que vai responder) e a
 * forma da resposta.
 */
import { describe, expect, it, vi } from "vitest";

import { agenteJaRespondeuNoAtendimento } from "./agente-ja-respondeu";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const AGENTE = "agente-1";

function dbCom(rows: Array<{ respondeu: boolean }>) {
  // Assinatura declarada (e não `vi.fn(async () => …)`): é o que permite
  // inspecionar `mock.calls[0][1]` sem `never[]`.
  return { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows })) };
}

describe("agenteJaRespondeuNoAtendimento", () => {
  it("pergunta pelo agente QUE VAI RESPONDER (ponto 2 do CR), não pela conversa", async () => {
    const db = dbCom([{ respondeu: true }]);
    await expect(
      agenteJaRespondeuNoAtendimento(db as never, {
        organizationId: ORG,
        conversationId: CONVERSA,
        agentId: AGENTE,
      }),
    ).resolves.toBe(true);
    expect(db.query.mock.calls[0]?.[1]).toEqual([ORG, CONVERSA, AGENTE]);
  });

  it("sem resposta do agente nesta conversa, a âncora é falsa (o filtro vale)", async () => {
    const db = dbCom([{ respondeu: false }]);
    await expect(
      agenteJaRespondeuNoAtendimento(db as never, {
        organizationId: ORG,
        conversationId: CONVERSA,
        agentId: AGENTE,
      }),
    ).resolves.toBe(false);
  });

  it("linha ausente (org/conversa inexistente) ⇒ false: falha aberta, nunca engajamento inventado", async () => {
    const db = dbCom([]);
    await expect(
      agenteJaRespondeuNoAtendimento(db as never, {
        organizationId: ORG,
        conversationId: CONVERSA,
        agentId: AGENTE,
      }),
    ).resolves.toBe(false);
  });

  it("a consulta é a outbound de IA dentro do atendimento corrente, e não o sticky", async () => {
    const db = dbCom([{ respondeu: false }]);
    await agenteJaRespondeuNoAtendimento(db as never, {
      organizationId: ORG,
      conversationId: CONVERSA,
      agentId: AGENTE,
    });
    const sql = String(db.query.mock.calls[0]?.[0] ?? "");
    expect(sql).toMatch(/m\.direction = 'outbound'/);
    expect(sql).toMatch(/m\.sent_via = 'ai'/);
    expect(sql).toMatch(/m\.metadata->>'ai_actor_id' = \$3/);
    expect(sql).toMatch(/m\.status <> 'failed'/);
    expect(sql).toMatch(/c\.service_started_at is null or m\.sent_at >= c\.service_started_at/);
    expect(sql).not.toMatch(/active_ai_agent_id/);
  });
});
