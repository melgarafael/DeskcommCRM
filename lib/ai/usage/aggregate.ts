/**
 * Monta o payload da tela "Uso de IA" a partir do que `public.fn_uso_de_ia`
 * já agregou no banco (migration 0523).
 *
 * A agregação morava aqui, em JS, sobre as linhas de `llm_calls` — e o PostgREST
 * entrega no máximo `max_rows` (1000) linhas: passada a milésima chamada do
 * período, os dias mais recentes sumiam da conta. Agora o banco soma tudo e este
 * arquivo só completa os dias sem uso e calcula as razões. (A tabela histórica
 * `ai_invocations` não é lida aqui nem pela função.)
 */
import { z } from "zod";

const numero = z.coerce.number();

const agregadoSchema = z.object({
  chamadas: numero,
  custo_cents: numero,
  input_tokens: numero,
  output_tokens: numero,
  cache_read_tokens: numero,
  cache_write_tokens: numero,
  p50_latency_ms: numero,
  p95_latency_ms: numero,
});

/** O `jsonb` devolvido por `fn_uso_de_ia`. */
export const usoDeIaSchema = z.object({
  // Turnos só nos totais: o custo de um turno é o do job inteiro, e ele não se
  // reparte por dia nem por purpose sem mudar de definição.
  totais: agregadoSchema.extend({ turnos: numero, custo_dos_turnos_cents: numero }),
  dias: z.array(agregadoSchema.extend({ dia: z.string() })),
  purposes: z.array(agregadoSchema.extend({ purpose: z.string() })),
  inbounds: z.record(z.string(), numero),
  handoffs: z.record(z.string(), numero),
});

export type UsoDeIaDoBanco = z.infer<typeof usoDeIaSchema>;

export interface UsagePayload {
  range: { from: string; to: string };
  totals: {
    cost_cents: number;
    total_tokens: number;
    /** Chamadas ao modelo — NÃO atendimentos: um turno do agente faz várias. */
    invocations: number;
    input_tokens: number;
    cache_read_tokens: number;
    /** cache_read / input (o input já inclui a parte lida do cache). */
    cache_hit_rate: number;
    agent_turns: number;
    /** null quando não houve turno: zero seria um custo inventado. */
    avg_cost_per_turn_cents: number | null;
    /** Latência de UMA chamada ao modelo, não do atendimento inteiro. */
    p50_latency_ms: number;
    p95_latency_ms: number;
    handoff_rate: number;
  };
  series: {
    cost_cents: Array<{ day: string; value: number }>;
    total_tokens: Array<{ day: string; value: number }>;
    p50_latency_ms: Array<{ day: string; value: number }>;
    p95_latency_ms: Array<{ day: string; value: number }>;
    handoff_rate: Array<{ day: string; value: number }>;
  };
  by_kind: Record<string, number>;
}

/** Format a Date as YYYY-MM-DD in UTC. */
export function toUtcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build a contiguous list of UTC day strings from `from` to `to` inclusive. */
export function daysBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor.getTime() <= end.getTime()) {
    out.push(toUtcDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function razao(parte: number, todo: number): number {
  return todo > 0 ? Number((parte / todo).toFixed(4)) : 0;
}

export function montarPayloadDeUso(
  uso: UsoDeIaDoBanco,
  range: { from: Date; to: Date },
): UsagePayload {
  const days = daysBetween(range.from, range.to);
  const porDia = new Map(uso.dias.map((d) => [d.dia, d]));
  const serie = (valor: (day: string) => number) => days.map((day) => ({ day, value: valor(day) }));

  let totalInbounds = 0;
  let totalHandoffs = 0;
  for (const day of days) {
    totalInbounds += uso.inbounds[day] ?? 0;
    totalHandoffs += uso.handoffs[day] ?? 0;
  }

  const t = uso.totais;
  return {
    range: { from: toUtcDay(range.from), to: toUtcDay(range.to) },
    totals: {
      cost_cents: t.custo_cents,
      total_tokens: t.input_tokens + t.output_tokens,
      invocations: t.chamadas,
      input_tokens: t.input_tokens,
      cache_read_tokens: t.cache_read_tokens,
      cache_hit_rate: razao(t.cache_read_tokens, t.input_tokens),
      agent_turns: t.turnos,
      avg_cost_per_turn_cents: t.turnos > 0 ? t.custo_dos_turnos_cents / t.turnos : null,
      p50_latency_ms: t.p50_latency_ms,
      p95_latency_ms: t.p95_latency_ms,
      handoff_rate: razao(totalHandoffs, totalInbounds),
    },
    series: {
      cost_cents: serie((day) => porDia.get(day)?.custo_cents ?? 0),
      total_tokens: serie((day) => {
        const d = porDia.get(day);
        return d ? d.input_tokens + d.output_tokens : 0;
      }),
      p50_latency_ms: serie((day) => porDia.get(day)?.p50_latency_ms ?? 0),
      p95_latency_ms: serie((day) => porDia.get(day)?.p95_latency_ms ?? 0),
      handoff_rate: serie((day) => razao(uso.handoffs[day] ?? 0, uso.inbounds[day] ?? 0)),
    },
    by_kind: Object.fromEntries(uso.purposes.map((p) => [p.purpose, p.chamadas])),
  };
}
