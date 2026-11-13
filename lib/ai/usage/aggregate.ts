/**
 * Monta o payload da tela "Uso de IA" a partir do que `public.fn_uso_de_ia`
 * já agregou no banco (migration 0586).
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
  /**
   * Recorte CACHEÁVEL do mesmo bucket (entrada >= MIN_TOKENS_DE_ENTRADA_PARA_CACHE,
   * `fn_uso_de_ia` da migration 9365). A taxa de cache da tela divide por estes,
   * não pelos totais acima: chamada abaixo do piso do provedor nunca cacheia e
   * afundaria a taxa sem defeito de prefixo nenhum (#4362).
   */
  chamadas_cacheaveis: numero,
  input_tokens_cacheaveis: numero,
  cache_read_tokens_cacheaveis: numero,
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
    /**
     * cache_read / input das chamadas CACHEÁVEIS (o input já inclui a parte lida
     * do cache). É a régua do #4362: entrada abaixo de
     * MIN_TOKENS_DE_ENTRADA_PARA_CACHE não entra — o provedor não guarda prefixo
     * desse tamanho, então ela não diz nada sobre o prefixo do prompt.
     */
    cache_hit_rate: number;
    /** tokens de entrada e de cache das chamadas cacheáveis, para quem quiser a conta crua */
    cacheable_input_tokens: number;
    cacheable_cache_read_tokens: number;
    /** chamadas cacheáveis — o denominador de `cache_hit_rate` em contagem, não em tokens */
    cacheable_invocations: number;
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
      // A taxa NÃO é cache_read/input de tudo: as chamadas abaixo do piso do
      // provedor (classificadores, conferências curtas) nunca cacheiam e
      // entravam no denominador como "0% de cache" (#4362). Ver a régua em
      // lib/ai/cache-de-prompt.ts.
      cache_hit_rate: razao(t.cache_read_tokens_cacheaveis, t.input_tokens_cacheaveis),
      cacheable_input_tokens: t.input_tokens_cacheaveis,
      cacheable_cache_read_tokens: t.cache_read_tokens_cacheaveis,
      cacheable_invocations: t.chamadas_cacheaveis,
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
