import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { recordRunMetrics } from "@/lib/agent-engine/obs/metrics";

/**
 * AS MÉTRICAS DO RUN GRAVAM — no Postgres do baseline, não num dublê.
 *
 * Medido em produção logo depois de atualizar para a 1.77: todo job concluído
 * logava `métricas do run não registradas` com
 * `column "organization_id" is of type uuid but expression is of type text`.
 * O INSERT passou a ser `select $1 … union all select $1 …`; dentro de um
 * UNION o Postgres resolve o parâmetro sem tipo como `text` antes de olhar a
 * coluna de destino — e `metrics.organization_id` é `uuid`. Sem o UNION, o tipo
 * vinha da coluna e ninguém via o problema.
 *
 * O teste de `lib/agent-engine/obs/metrics.test.ts` usa um pool de mentira: ele
 * confere o SQL montado, nunca o que o banco aceita. Por isso este mora aqui.
 * E a falha não é cosmética: o `evaluateCacheHitAlert` do worker vem DEPOIS do
 * `recordRunMetrics` no mesmo `try`, então o alerta de cache também parava.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = randomUUID();
const CONTATO = randomUUID();

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Métricas do run', 'Métricas do run')`,
    [ORG, `metricas-do-run-${ORG}`],
  );
});

afterAll(async () => {
  await pool.query("delete from metrics where organization_id = $1", [ORG]);
  await pool.query("delete from llm_calls where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

async function metricasDoJob(jobId: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ name: string; value: number }>(
    `select name, value::float8 as value from metrics
      where organization_id = $1 and labels->>'job_id' = $2`,
    [ORG, jobId],
  );
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}

describe("recordRunMetrics no banco real", () => {
  it("⭐ run com chamadas de IA e claim: grava as métricas do run, a espera na fila e o tempo total", async () => {
    const job = randomUUID();
    await pool.query(`insert into job_queue (id, organization_id, kind) values ($1, $2, 'watchdog')`, [job, ORG]);
    await pool.query(
      `insert into llm_calls (organization_id, job_id, purpose, provider, model,
                              input_tokens, output_tokens, cache_read_tokens, cost_cents, latency_ms)
       values ($1, $2, 'agent_turn', 'anthropic', 'claude-x', 1000, 100, 800, 2.5, 1200),
              ($1, $2, 'agent_turn', 'anthropic', 'claude-x', 500, 50, 0, 1.5, 800)`,
      [ORG, job],
    );
    const criado = new Date(Date.now() - 5_000);
    const claim = new Date(Date.now() - 3_000);

    const chamadas = await recordRunMetrics(pool, {
      id: job,
      organization_id: ORG,
      contact_id: CONTATO,
      kind: "inbound_turn",
      created_at: criado,
      claim_acquired_at: claim.toISOString(),
    });

    expect(chamadas).toBe(2);
    const m = await metricasDoJob(job);
    expect(m.run_llm_calls).toBe(2);
    expect(m.run_input_tokens).toBe(1500);
    expect(m.run_cost_cents).toBe(4);
    expect(m.run_llm_latency_ms).toBe(2000);
    // espera na fila = claim − criação; o tempo total vem do relógio do banco.
    expect(Object.keys(m).length).toBeGreaterThanOrEqual(8);
  });

  it("run sem chamada de IA, só com claim: ainda grava a espera e o tempo total", async () => {
    const job = randomUUID();
    const chamadas = await recordRunMetrics(pool, {
      id: job,
      organization_id: ORG,
      contact_id: CONTATO,
      kind: "followup_turn",
      created_at: new Date(Date.now() - 2_000),
      claim_acquired_at: new Date(Date.now() - 1_000).toISOString(),
    });

    expect(chamadas).toBe(0);
    expect(Object.keys(await metricasDoJob(job)).length).toBe(2);
  });
});
