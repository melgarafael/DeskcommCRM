/**
 * A TELA "USO DE IA" SOMA TUDO, E SÓ DA PRÓPRIA ORGANIZAÇÃO (migration 0586).
 *
 * A rota buscava as linhas de `llm_calls` pelo PostgREST e somava em JS. O
 * PostgREST corta em `max_rows` (1000) e a consulta era ascendente: passada a
 * milésima chamada do período, os dias mais recentes sumiam — e os inbounds e
 * as passagens para uma pessoa cortavam do mesmo jeito. `fn_uso_de_ia` soma no
 * banco e devolve um jsonb só.
 *
 * O que este arquivo prova num Postgres real com o baseline aplicado:
 *
 *   1. Com MAIS de 1000 linhas em cada fonte, o total da função bate com a soma
 *      direta em SQL — inclusive o dia mais recente, o que o corte apagava.
 *   2. "Turnos do agente" são jobs distintos com chamada `agent_turn`, e o custo
 *      do turno inclui as outras chamadas do mesmo job.
 *   3. Isolamento: a função é `security invoker`, então a pessoa da organização A
 *      que pede a B recebe ZERO — e o controle como dono do schema mostra que B
 *      tem dados, para o zero não ser um banco vazio passando por isolamento.
 *   4. `anon` não executa; `authenticated` executa (é quem a rota usa).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USUARIO_A = randomUUID();
const JOBS = [randomUUID(), randomUUID(), randomUUID()];
const DESDE = "2026-08-01T00:00:00.000Z";
const ATE = "2026-08-03T23:59:59.999Z";
const ASSINATURA = "public.fn_uso_de_ia(uuid, timestamptz, timestamptz, uuid, text)";

/** 1200 chamadas comuns + 7 do turno: 6 agent_turn em 3 jobs e 1 classify no job 1. */
const CHAMADAS_A = 1207;
const INBOUNDS_A = 1100;
const HANDOFFS_A = 1010;

interface Agregado {
  chamadas: number;
  custo_cents: number;
  input_tokens: number;
  cache_read_tokens: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  turnos: number;
  custo_dos_turnos_cents: number;
}
interface Uso {
  totais: Agregado;
  dias: Array<Agregado & { dia: string }>;
  purposes: Array<Agregado & { purpose: string }>;
  inbounds: Record<string, number>;
  handoffs: Record<string, number>;
}

function ultimaLinha(saida: string): string {
  return saida.split("\n").filter(Boolean).at(-1) ?? "";
}

function usoComo(papel: "authenticated" | "dono", org: string, purpose: string | null = null): Uso {
  const chamada = `select public.fn_uso_de_ia('${org}', '${DESDE}', '${ATE}', null, ${purpose ? `'${purpose}'` : "null"})::text;`;
  const prefixo =
    papel === "authenticated"
      ? `set role authenticated; select set_config('request.jwt.claims', '{"sub":"${USUARIO_A}","role":"authenticated"}', false);`
      : "";
  return JSON.parse(ultimaLinha(sql(`${prefixo}\n${chamada}`))) as Uso;
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${USUARIO_A}', 'uso-ia-a-${USUARIO_A}@invariant.test');
    insert into organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'uso-ia-a-${ORG_A}', 'Uso A', 'Uso A'),
      ('${ORG_B}', 'uso-ia-b-${ORG_B}', 'Uso B', 'Uso B');
    insert into user_organizations (user_id, organization_id, role, accepted_at)
      values ('${USUARIO_A}', '${ORG_A}', 'manager', now());

    -- 1200 chamadas espalhadas nos 3 dias; o dia 3 é o "mais recente" que o corte apagava.
    insert into llm_calls (organization_id, purpose, provider, model, input_tokens, output_tokens,
                           cache_read_tokens, cost_cents, latency_ms, created_at)
    select '${ORG_A}', case when g % 4 = 0 then 'intent_router' else 'classify' end, 'anthropic', 'claude-x',
           100 + g % 50, 20, g % 60, (g % 7) * 0.5, 200 + (g * 37) % 5000,
           '${DESDE}'::timestamptz + make_interval(secs => (g - 1) * 215)
      from generate_series(1, 1200) g;

    insert into job_queue (id, organization_id, kind) values
      ('${JOBS[0]}', '${ORG_A}', 'watchdog'), ('${JOBS[1]}', '${ORG_A}', 'watchdog'), ('${JOBS[2]}', '${ORG_A}', 'watchdog');
    insert into llm_calls (organization_id, job_id, purpose, provider, model, cost_cents, latency_ms, created_at)
    select '${ORG_A}', j.id, 'agent_turn', 'anthropic', 'claude-x', 10, 1500, '2026-08-03T12:00:00Z'
      from (values ('${JOBS[0]}'::uuid), ('${JOBS[1]}'::uuid), ('${JOBS[2]}'::uuid)) j(id), generate_series(1, 2);
    insert into llm_calls (organization_id, job_id, purpose, provider, model, cost_cents, latency_ms, created_at)
      values ('${ORG_A}', '${JOBS[0]}', 'classify', 'anthropic', 'claude-x', 4, 300, '2026-08-03T12:00:01Z');

    -- B tem dados no MESMO período: o zero que A recebe tem de ser isolamento.
    insert into llm_calls (organization_id, purpose, provider, model, cost_cents, latency_ms, created_at)
    select '${ORG_B}', 'agent_turn', 'anthropic', 'claude-x', 999, 100, '2026-08-02T10:00:00Z'
      from generate_series(1, 5);
  `);

  const sessao = randomUUID();
  const contato = randomUUID();
  const conversa = randomUUID();
  sql(`
    insert into channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${sessao}', '${ORG_A}', 'uso-ia-${sessao}', '\\x00'::bytea);
    insert into contacts (id, organization_id, display_name) values ('${contato}', '${ORG_A}', 'Contato');
    insert into conversations (id, organization_id, contact_id, channel_session_id)
      values ('${conversa}', '${ORG_A}', '${contato}', '${sessao}');
    insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, created_at)
    select '${ORG_A}', '${conversa}', '${sessao}', '${contato}', 'text', 'inbound',
           '${DESDE}'::timestamptz + make_interval(secs => g * 230)
      from generate_series(1, ${INBOUNDS_A}) g;
    insert into event_log (organization_id, event_type, entity_kind, created_at)
    select '${ORG_A}', 'ai.handoff_triggered', 'conversation', '${DESDE}'::timestamptz + make_interval(secs => g * 250)
      from generate_series(1, ${HANDOFFS_A}) g;
  `);
});

afterAll(() => {
  sql(`
    delete from organizations where id in ('${ORG_A}', '${ORG_B}');
    delete from auth.users where id = '${USUARIO_A}';
  `);
});

describe("fn_uso_de_ia soma tudo — mais de 1000 linhas por fonte", () => {
  it("o total bate com a soma direta em SQL, chamada a chamada", () => {
    const uso = usoComo("authenticated", ORG_A);
    const [chamadas, custo, input, cacheRead, p50, p95] = ultimaLinha(
      sql(`select count(*), sum(cost_cents), sum(input_tokens), sum(cache_read_tokens),
                  percentile_disc(0.5) within group (order by latency_ms),
                  percentile_disc(0.95) within group (order by latency_ms)
             from llm_calls where organization_id = '${ORG_A}';`),
    ).split("|");

    expect(Number(chamadas)).toBe(CHAMADAS_A);
    expect(uso.totais.chamadas).toBe(CHAMADAS_A);
    expect(uso.totais.custo_cents).toBe(Number(custo));
    expect(uso.totais.input_tokens).toBe(Number(input));
    expect(uso.totais.cache_read_tokens).toBe(Number(cacheRead));
    expect(uso.totais.p50_latency_ms).toBe(Number(p50));
    expect(uso.totais.p95_latency_ms).toBe(Number(p95));
  });

  it("o dia mais recente está lá, e os dias somam o total", () => {
    const uso = usoComo("authenticated", ORG_A);
    expect(uso.dias.map((d) => d.dia)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(uso.dias.reduce((s, d) => s + d.chamadas, 0)).toBe(CHAMADAS_A);
    const recente = ultimaLinha(
      sql(`select count(*) from llm_calls where organization_id = '${ORG_A}' and created_at >= '2026-08-03T00:00:00Z';`),
    );
    expect(uso.dias.at(-1)?.chamadas).toBe(Number(recente));
  });

  it("inbounds e passagens para uma pessoa não cortam em 1000", () => {
    const uso = usoComo("authenticated", ORG_A);
    expect(Object.values(uso.inbounds).reduce((s, n) => s + n, 0)).toBe(INBOUNDS_A);
    expect(Object.values(uso.handoffs).reduce((s, n) => s + n, 0)).toBe(HANDOFFS_A);
  });

  it("turno = job distinto com agent_turn, e o custo inclui as outras chamadas do job", () => {
    const uso = usoComo("authenticated", ORG_A);
    expect(uso.totais.turnos).toBe(3);
    expect(uso.totais.custo_dos_turnos_cents).toBe(6 * 10 + 4);
    const porPurpose = Object.fromEntries(uso.purposes.map((p) => [p.purpose, p.chamadas]));
    expect(porPurpose.agent_turn).toBe(6);
  });

  it("o filtro por purpose continua valendo", () => {
    const uso = usoComo("authenticated", ORG_A, "agent_turn");
    expect(uso.totais.chamadas).toBe(6);
    expect(uso.purposes.map((p) => p.purpose)).toEqual(["agent_turn"]);
  });
});

describe("fn_uso_de_ia não atravessa organização", () => {
  it("a pessoa de A que pede B recebe zero — e B tem dados", () => {
    const deFora = usoComo("authenticated", ORG_B);
    expect(deFora.totais.chamadas).toBe(0);
    expect(deFora.totais.custo_cents).toBe(0);
    expect(deFora.dias).toEqual([]);

    const controle = usoComo("dono", ORG_B);
    expect(controle.totais.chamadas).toBe(5);
  });

  it("anon não executa; authenticated executa", () => {
    const [anon, autenticado] = ultimaLinha(
      sql(`select has_function_privilege('anon', '${ASSINATURA}', 'execute'),
                  has_function_privilege('authenticated', '${ASSINATURA}', 'execute');`),
    ).split("|");
    expect(anon).toBe("f");
    expect(autenticado).toBe("t");
  });
});
