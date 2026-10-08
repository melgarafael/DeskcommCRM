/**
 * A TELA "USO DE IA" NÃO SOMA UMA AMOSTRA, E OS RÓTULOS DIZEM O QUE MEDEM.
 *
 * A rota buscava as linhas de `llm_calls` e somava em JS. O PostgREST entrega no
 * máximo `max_rows` (1000) linhas e a ordem era ascendente: passada a milésima
 * chamada, os dias mais recentes sumiam do custo, dos tokens e da latência — e o
 * denominador da taxa de passagem para uma pessoa cortava igual. A migration
 * 0586 levou a soma para `fn_uso_de_ia`; a prova com mais de 1000 linhas num
 * Postgres de verdade é `tests/invariants/uso-de-ia-agregado-no-banco.test.ts`.
 * Aqui fica o que se mede sem banco: a rota não volta a buscar linhas, o schema
 * anda igual nos dois artefatos, e o payload diz a verdade sobre o que recebeu.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { montarPayloadDeUso, usoDeIaSchema, type UsoDeIaDoBanco } from "@/lib/ai/usage/aggregate";

const ROTA = readFileSync("app/api/v1/ai/usage/route.ts", "utf8");
const MIGRATION = readFileSync("supabase/migrations/20261007131331_0586_uso_de_ia_agregado_no_banco.sql", "utf8");
const BASELINE = readFileSync("supabase/baseline.sql", "utf8");
const ASSINATURA = "public.fn_uso_de_ia(uuid, timestamptz, timestamptz, uuid, text)";

function definicao(sql: string): string | null {
  const inicio = sql.search(/^create or replace function public\.fn_uso_de_ia\(/m);
  if (inicio === -1) return null;
  return sql.slice(inicio, sql.indexOf("$$;", inicio) + 3);
}

describe("a rota soma no banco, não sobre o que o PostgREST deixou passar", () => {
  it("chama a função e não busca linhas de telemetria, mensagem ou evento", () => {
    expect(ROTA).toContain('.rpc("fn_uso_de_ia"');
    for (const tabela of ["llm_calls", "messages", "event_log"]) {
      expect(ROTA, `a rota voltou a buscar linhas de ${tabela} para somar em JS`).not.toContain(
        `.from("${tabela}")`,
      );
    }
  });

  it("a função é a mesma na migration e no baseline, invoker, e fechada para anon", () => {
    const naMigration = definicao(MIGRATION);
    expect(naMigration).not.toBeNull();
    expect(definicao(BASELINE)).toBe(naMigration);
    expect(naMigration).toMatch(/security invoker/);
    for (const texto of [MIGRATION, BASELINE]) {
      expect(texto).toContain(`revoke execute on function ${ASSINATURA}\n  from public, anon;`);
    }
  });

  it("o apêndice entra antes da varredura de anon", () => {
    const bloco = BASELINE.indexOf("(migration 0586) ----");
    expect(bloco).toBeGreaterThan(-1);
    expect(bloco).toBeLessThan(BASELINE.search(/^-- ---- VARREDURA anon:/m));
  });

  // O comportamento é provado no invariante (Postgres real); aqui fica a forma,
  // que se mede sem banco e reprova o retorno dos dois defeitos de régua.
  it("turno conta só agent_turn que deu certo, e não herda o filtro de purpose", () => {
    const corpo = definicao(MIGRATION) ?? "";
    const cte = (nome: string) => {
      const inicio = corpo.indexOf(`  ${nome} as (`);
      return inicio === -1 ? "" : corpo.slice(inicio, corpo.indexOf("\n  ),", inicio));
    };
    const jobs = cte("jobs_de_turno");
    const turnos = cte("turnos");
    expect(jobs, "a chamada agent_turn que falhou (status 'erro') virava turno").toMatch(
      /c\.status = 'ok'/,
    );
    for (const [nome, trecho] of [["jobs_de_turno", jobs], ["turnos", turnos]] as const) {
      expect(trecho, `${nome} sumiu da função`).toMatch(/from public\.llm_calls c/);
      expect(trecho, `${nome} filtra por purpose: o custo do turno deixa de ser o do job`).not.toMatch(
        /p_purpose/,
      );
    }
    expect(turnos, "o custo do turno só pode filtrar o agente pelo job").not.toMatch(/p_agent_id/);
  });
});

const zero = {
  chamadas: 0,
  custo_cents: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  p50_latency_ms: 0,
  p95_latency_ms: 0,
};

const range = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-03T00:00:00Z") };

describe("montarPayloadDeUso", () => {
  const uso: UsoDeIaDoBanco = {
    totais: {
      ...zero,
      chamadas: 1500,
      custo_cents: 300,
      input_tokens: 10_000,
      output_tokens: 2_000,
      cache_read_tokens: 6_000,
      p50_latency_ms: 800,
      p95_latency_ms: 4000,
      turnos: 40,
      custo_dos_turnos_cents: 200,
    },
    dias: [
      { ...zero, dia: "2026-09-03", chamadas: 1500, custo_cents: 300, input_tokens: 10_000, output_tokens: 2_000, p50_latency_ms: 800, p95_latency_ms: 4000 },
    ],
    purposes: [
      { ...zero, purpose: "agent_turn", chamadas: 1200 },
      { ...zero, purpose: "intent_router", chamadas: 300 },
    ],
    inbounds: { "2026-09-02": 10, "2026-09-03": 30 },
    handoffs: { "2026-09-03": 3 },
  };

  it("o dia mais recente do período aparece com o total do banco", () => {
    const p = montarPayloadDeUso(uso, range);
    expect(p.series.cost_cents).toEqual([
      { day: "2026-09-01", value: 0 },
      { day: "2026-09-02", value: 0 },
      { day: "2026-09-03", value: 300 },
    ]);
    expect(p.totals.invocations).toBe(1500);
    expect(p.totals.total_tokens).toBe(12_000);
  });

  it("separa chamadas de turnos e calcula custo por turno e taxa de cache", () => {
    const p = montarPayloadDeUso(uso, range);
    expect(p.totals.agent_turns).toBe(40);
    expect(p.totals.avg_cost_per_turn_cents).toBe(5);
    expect(p.totals.cache_hit_rate).toBe(0.6);
    expect(p.by_kind).toEqual({ agent_turn: 1200, intent_router: 300 });
  });

  it("a taxa de passagem usa todos os inbounds do período", () => {
    const p = montarPayloadDeUso(uso, range);
    expect(p.totals.handoff_rate).toBe(0.075);
    expect(p.series.handoff_rate.map((d) => d.value)).toEqual([0, 0, 0.1]);
  });

  it("sem turno, o custo por turno é null — nunca um zero inventado", () => {
    const p = montarPayloadDeUso({ ...uso, totais: { ...uso.totais, turnos: 0 } }, range);
    expect(p.totals.avg_cost_per_turn_cents).toBeNull();
  });

  it("um número que chegue como texto é convertido, não recusado", () => {
    const cru = { ...uso, totais: { ...uso.totais, custo_cents: "300.5" } };
    expect(usoDeIaSchema.parse(cru).totais.custo_cents).toBe(300.5);
  });
});
