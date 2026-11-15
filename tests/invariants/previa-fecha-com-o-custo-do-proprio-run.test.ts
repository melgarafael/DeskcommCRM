/**
 * A SOMA QUE FECHA O TESTE É POR RUN, E SÓ NO POSTGRES SE PROVA (#4664).
 *
 * O caso de unidade (`tests/unit/fechamento-do-teste-soma-o-custo-do-proprio-run`)
 * prova que a ROTA grava o que a soma devolveu; ele não prova que o SQL soma o
 * que se espera — um dublê aceita qualquer coluna e qualquer predicado. Aqui a
 * instrução roda num Postgres de verdade, com as linhas que o defeito original
 * produzia:
 *
 *  - dois runs de prévia do MESMO agente, no MESMO instante, com custos
 *    diferentes — cada um tem de ver o SEU total;
 *  - um run sem chamada nenhuma — zero medido, não erro;
 *  - chamadas que NÃO são deste run (outro run no mesmo segundo, e uma chamada
 *    de turno real, sem `preview_run_id`) — fora da soma;
 *  - `cost_cents` nulo numa das chamadas (modelo sem preço) — não pode anular a
 *    soma nem virar NaN.
 *
 * Roda só no CI e em `pnpm test:db` (precisa de Postgres).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { somarCustoDoRunDePrevia } from "@/lib/ai/agents/custo-do-run-de-previa";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});

const org = randomUUID();
const runA = randomUUID();
const runB = randomUUID();
const runVazio = randomUUID();
const runAlheio = randomUUID();

/** Todas as chamadas nascem no MESMO instante: é a premissa do defeito. */
const instante = "2026-11-15T12:00:00.000Z";

async function chamada(extra: {
  previewRunId: string | null;
  tokensIn: number;
  tokensOut: number;
  cost: number | null;
  agentId?: string | null;
}) {
  await pool.query(
    `insert into llm_calls
       (organization_id, purpose, provider, model, input_tokens, output_tokens,
        cost_cents, status, agent_id, preview_run_id, created_at)
     values ($1, 'agent_preview', 'openai', 'gpt-6.1-terra', $2, $3, $4, 'ok', $5, $6, $7)`,
    [
      org,
      extra.tokensIn,
      extra.tokensOut,
      extra.cost,
      extra.agentId ?? null,
      extra.previewRunId,
      instante,
    ],
  );
}

beforeAll(async () => {
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Soma','Soma')",
    [org],
  );

  // Run A — duas chamadas do próprio teste.
  await chamada({ previewRunId: runA, tokensIn: 120, tokensOut: 30, cost: 3.5 });
  await chamada({ previewRunId: runA, tokensIn: 30, tokensOut: 0, cost: 0.5 });

  // Run B — outro teste do MESMO agente, disparado no mesmo instante.
  await chamada({ previewRunId: runB, tokensIn: 700, tokensOut: 90, cost: 11 });

  // Run alheio, também simultâneo — e com uma chamada sem preço, que o `sum`
  // tem de ignorar sem zerar o resto.
  await chamada({ previewRunId: runAlheio, tokensIn: 5000, tokensOut: 500, cost: 42 });
  await chamada({ previewRunId: runAlheio, tokensIn: 1, tokensOut: 1, cost: null });

  // Turno REAL: sem `preview_run_id`, a mesma organização e o mesmo segundo.
  await chamada({ previewRunId: null, tokensIn: 9000, tokensOut: 900, cost: 99 });
});

afterAll(async () => {
  await pool.end();
});

describe("a soma do run de prévia, medida no Postgres (#4664)", () => {
  it("soma só as chamadas do run pedido — no mesmo instante do outro teste", async () => {
    expect(await somarCustoDoRunDePrevia(pool, org, runA)).toEqual({
      tokens_in: 150,
      tokens_out: 30,
      cost_cents: 4,
    });
    expect(await somarCustoDoRunDePrevia(pool, org, runB)).toEqual({
      tokens_in: 700,
      tokens_out: 90,
      cost_cents: 11,
    });
  });

  it("run sem chamada nenhuma devolve zero, e não nulo nem erro", async () => {
    expect(await somarCustoDoRunDePrevia(pool, org, runVazio)).toEqual({
      tokens_in: 0,
      tokens_out: 0,
      cost_cents: 0,
    });
  });

  it("chamada de outro run no mesmo instante e turno real ficam fora", async () => {
    const alheio = await somarCustoDoRunDePrevia(pool, org, runAlheio);
    // A chamada sem preço soma tokens e não vira NaN: `cost_cents` nulo é
    // "preço desconhecido" numa linha, não o preço do run inteiro.
    expect(alheio).toEqual({ tokens_in: 5001, tokens_out: 501, cost_cents: 42 });

    // O total de tudo que existe na organização, no mesmo segundo, é 14.851
    // tokens e 156,00 de custo (o nulo não entra em nenhuma das somas). Nenhum
    // dos runs pode ter esse número.
    for (const run of [runA, runB, runAlheio]) {
      const soma = await somarCustoDoRunDePrevia(pool, org, run);
      expect(soma?.tokens_in).not.toBe(14_851);
      expect(soma?.cost_cents).not.toBe(156);
    }
  });
});
