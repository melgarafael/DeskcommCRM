/**
 * "TURNOS DO AGENTE" TÊM UMA DEFINIÇÃO SÓ, COM OU SEM FILTRO (migration 0523).
 *
 * Turno = job distinto com chamada `agent_turn` que deu certo; o custo do turno
 * é o do job inteiro. Dois defeitos de régua que este arquivo prende num
 * Postgres real:
 *
 *   1. O `registrarFalha` do run-model-call grava a chamada que falhou como
 *      `agent_turn` com status 'erro' e custo null. Contar o job dela como turno
 *      inventa respostas que nunca saíram e puxa o custo médio para baixo.
 *   2. Só a chamada `agent_turn` grava `agent_id`; checkpoint, classificador e
 *      compactação do mesmo job gravam null. Se os filtros de agente e de
 *      purpose cortassem as chamadas antes de marcar os turnos, o mesmo cartão
 *      mostraria um custo menor com o filtro de agente, e "sem turnos" ao
 *      filtrar por outro tipo.
 *
 * A forma das CTEs é cobrada sem banco em tests/unit/uso-de-ia-tela-honesta.test.ts.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const ORG = randomUUID();
const USUARIO = randomUUID();
const AGENTE = randomUUID();
/** Jobs 0-2 tiveram turno; o 3 só tem um agent_turn que FALHOU. */
const JOBS = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const DESDE = "2026-08-01T00:00:00.000Z";
const ATE = "2026-08-03T23:59:59.999Z";

interface Totais {
  chamadas: number;
  turnos: number;
  custo_dos_turnos_cents: number;
}

function ultimaLinha(saida: string): string {
  return saida.split("\n").filter(Boolean).at(-1) ?? "";
}

function totais(purpose: string | null = null, agente: string | null = null): Totais {
  const literal = (v: string | null) => (v ? `'${v}'` : "null");
  const saida = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${USUARIO}","role":"authenticated"}', false);
    select public.fn_uso_de_ia('${ORG}', '${DESDE}', '${ATE}', ${literal(agente)}, ${literal(purpose)})::text;
  `);
  return (JSON.parse(ultimaLinha(saida)) as { totais: Totais }).totais;
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${USUARIO}', 'uso-turno-${USUARIO}@invariant.test');
    insert into organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'uso-turno-${ORG}', 'Uso Turno', 'Uso Turno');
    insert into user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USUARIO}', '${ORG}', 'manager', now());
    insert into ai_agents (id, organization_id, name, system_prompt)
      values ('${AGENTE}', '${ORG}', 'uso-turno-${AGENTE}', 'x');

    insert into job_queue (id, organization_id, kind)
    select j.id, '${ORG}', 'watchdog' from unnest(array['${JOBS.join("','")}']::uuid[]) j(id);

    -- 2 agent_turn ok por job nos jobs 0-2; só as do job 0 levam o agente.
    insert into llm_calls (organization_id, job_id, agent_id, purpose, provider, model, cost_cents, latency_ms, created_at)
    select '${ORG}', j.id, j.agente, 'agent_turn', 'anthropic', 'claude-x', 10, 1500, '2026-08-03T12:00:00Z'
      from (values ('${JOBS[0]}'::uuid, '${AGENTE}'::uuid), ('${JOBS[1]}'::uuid, null), ('${JOBS[2]}'::uuid, null)) j(id, agente),
           generate_series(1, 2);
    -- Como o checkpoint do inbound-turn: mesmo job, sem agent_id.
    insert into llm_calls (organization_id, job_id, purpose, provider, model, cost_cents, latency_ms, created_at)
      values ('${ORG}', '${JOBS[0]}', 'classify', 'anthropic', 'claude-x', 4, 300, '2026-08-03T12:00:01Z');
    -- Como o registrarFalha do run-model-call: agent_turn com status 'erro' e custo null.
    insert into llm_calls (organization_id, job_id, purpose, provider, model, cost_cents, latency_ms, status, created_at)
      values ('${ORG}', '${JOBS[3]}', 'agent_turn', 'anthropic', 'claude-x', null, 900, 'erro', '2026-08-03T12:00:02Z');
  `);
});

afterAll(() => {
  sql(`
    delete from organizations where id = '${ORG}';
    delete from auth.users where id = '${USUARIO}';
  `);
});

describe("fn_uso_de_ia: o que é um turno", () => {
  it("o job que só tem agent_turn com erro não é turno, mas a chamada conta", () => {
    const t = totais();
    expect(t.chamadas).toBe(8);
    // Contar o job 3 daria 4 turnos e 16 de média em vez de 64/3.
    expect(t.turnos).toBe(3);
    expect(t.custo_dos_turnos_cents).toBe(6 * 10 + 4);
  });

  it("filtrar por outro tipo de uso não apaga os turnos nem o custo deles", () => {
    const t = totais("classify");
    expect(t.chamadas).toBe(1);
    expect(t.turnos).toBe(3);
    expect(t.custo_dos_turnos_cents).toBe(6 * 10 + 4);
  });

  it("o filtro por agente escolhe os jobs, e o custo do job segue inteiro", () => {
    const t = totais(null, AGENTE);
    expect(t.chamadas).toBe(2);
    expect(t.turnos).toBe(1);
    // O classify do job 0 não tem agent_id: filtrar as chamadas antes daria 20.
    expect(t.custo_dos_turnos_cents).toBe(2 * 10 + 4);
  });
});
