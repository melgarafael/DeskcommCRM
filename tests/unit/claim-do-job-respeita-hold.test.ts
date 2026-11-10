import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { claimJobs, faltaParaOProximoJob } from "@/lib/agent-engine/queue/queue";

/**
 * Guarda do contrato entre o claim e o relógio, sem fingir que o dublê executa
 * SQL. A semântica por canal/motivo roda contra Postgres no invariante irmão.
 * Se apenas o claim filtrar holds, o job continua vencido e sem as marcas que
 * permitem à liberação espaçar o retorno. O claim precisa reter, e o relógio
 * pode então dormir: a fila já guardou o horário original em `held_run_after`.
 */
async function consultas(): Promise<{ claim: string; relogio: string }> {
  const chamadas: string[] = [];
  const client = {
    query: async (sql: string) => {
      chamadas.push(sql);
      return { rows: /count\(\*\)/i.test(sql) ? [{ n: 0 }] : [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string) => {
      chamadas.push(sql);
      return { rows: [{ falta_ms: null }], rowCount: 1 };
    },
  } as unknown as Pool;
  await claimJobs(pool, { workerId: "worker-de-teste", maxConcurrency: 1 });
  await faltaParaOProximoJob(pool);
  return {
    claim: chamadas.find((sql) => sql.includes("select distinct on")) ?? "",
    relogio: chamadas.find((sql) => /as falta_ms/i.test(sql)) ?? "",
  };
}

describe("a fila respeita o hold antes do tick do watchdog (#2327)", () => {
  it("o claim considera a saúde do canal ANTES de escolher um job por contato", async () => {
    const { claim } = await consultas();
    expect(claim).toContain("channel_session_health");
    expect(claim).toContain("health_hold_reason");
    expect(claim).toContain("go_live");
    expect(claim).toContain("followup_turn");
    expect(claim).toMatch(/retidos as\s*\(\s*update job_queue/);
    expect(claim).toContain("select 1 from retidos");
    const candidatos = claim.slice(0, claim.indexOf("retidos as ("));
    expect(candidatos).toContain("as materialized");
    expect(candidatos).toContain("limit $1");
    expect(candidatos).toContain("for update of j skip locked");
  });

  it("o claim guarda a retenção e o relógio continua vendo jobs que ainda precisam dela", async () => {
    const { claim, relogio } = await consultas();
    expect(claim).toContain("'{held_run_after}'");
    expect(claim).toContain("'held_channel_session_id'");
    expect(claim).toContain("run_after = 'infinity'");
    expect(relogio).not.toContain("channel_session_health");
    expect(relogio).toContain("least(min(run_after), now() + interval '1 day')");
  });

  it("o claim resolve a conversa pelo tenant e contato, sem cast do payload", async () => {
    const { claim } = await consultas();
    expect(claim).toContain("c.organization_id = j.organization_id");
    expect(claim).toContain("c.contact_id = j.contact_id");
    expect(claim).toContain("c.id::text = j.payload #>> '{service_boundary,conversation_id}'");
    expect(claim).toContain("s.organization_id = j.organization_id");
    expect(claim).not.toMatch(/payload[^\n]*::uuid/);
  });
});
