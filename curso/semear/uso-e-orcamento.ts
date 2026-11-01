/**
 * Semente do módulo "Uso e orçamento" (Agente de IA › Ver tudo em IA › Uso e
 * orçamento, /app/ai/usage): 30 dias da Bia atendendo, para a foto ter números.
 *
 * A tela lê três coisas, e a semente escreve nas três:
 *  - `llm_calls` — a ÚNICA tabela de telemetria (`fn_uso_de_ia` soma custo,
 *    chamadas, tokens, cache e tempo; `fn_gasto_de_ia_do_mes` soma o mês para o
 *    card de orçamento). Cada turno da Bia é uma chamada `agent_turn` (Sonnet) e
 *    uma `sentiment_classify` (Haiku); um em três ainda identifica a etapa do
 *    lead, um em cinco fecha o atendimento. Toda linha tem custo: custo nulo
 *    acenderia o aviso "Parte do que a IA gastou este mês não entra nesta conta".
 *  - `job_queue` — "Turnos do agente" conta JOBS distintos com `agent_turn` ok.
 *    ponytail: os jobs nascem `watchdog` e `done`, como o invariante
 *    `tests/invariants/uso-de-ia-agregado-no-banco.test.ts` faz: um job de turno
 *    (`inbound_turn`) exige contato e fronteira de atendimento, e a tela não
 *    mostra o tipo do job. `done` = nenhum worker pega.
 *  - `event_log` — dois `ai.handoff_triggered` já `done` na última conversa,
 *    para "Passaram para uma pessoa" não ficar em zero.
 * E o teto: `ai_budgets` da clínica em "Me avisar ao passar de 80%" de US$ 15.
 *
 * A base apaga conversas e mensagens a cada aula, mas não estas tabelas — e a
 * aula de Uso (Admin) diz que a Bia "nunca foi chamada". Por isso `limpar`.
 * Idempotente: ids fixos `f1c002…` (jobs), `f1c003…` (chamadas), `f1c004…`
 * (eventos), apagados por faixa e recriados. Os números variam por uma conta
 * fixa, sem acaso: a foto não muda entre capturas.
 */
import { type Contexto, conversaId, ha, semErro } from "../semear-demonstracao";

const faixa = (bloco: string) =>
  [`f1c0${bloco}-0000-4000-8000-000000000000`, `f1c0${bloco}-0000-4000-8000-999999999999`] as const;
const idEm = (bloco: string, n: number) => `f1c0${bloco}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const JOBS = "0200";
const CHAMADAS = "0300";
const EVENTOS = "0400";
const DIA = 24 * 60;

/** US$ por milhão de tokens (lib/agent-engine/edge/llm/pricing.ts) → centavos. */
const PRECO = {
  "claude-sonnet-4-6": { entrada: 3, saida: 15, cache: 0.3 },
  "claude-haiku-4-5": { entrada: 1, saida: 5, cache: 0.1 },
} as const;
type Modelo = keyof typeof PRECO;
// `entrada` já INCLUI o que veio do cache (a tela divide cache por entrada): só o resto paga o preço cheio
const centavos = (m: Modelo, entrada: number, saida: number, cache: number) =>
  Number((((entrada - cache) * PRECO[m].entrada + saida * PRECO[m].saida + cache * PRECO[m].cache) / 10_000).toFixed(4));

export async function limpar(c: Contexto) {
  const { db, org } = c;
  // chamadas antes dos jobs: `llm_calls.job_id` aponta para eles
  const [c0, c1] = faixa(CHAMADAS);
  semErro(await db.from("llm_calls").delete().eq("organization_id", org).gte("id", c0).lte("id", c1), "limpar chamadas do curso");
  const [j0, j1] = faixa(JOBS);
  semErro(await db.from("job_queue").delete().eq("organization_id", org).gte("id", j0).lte("id", j1), "limpar turnos do curso");
  const [e0, e1] = faixa(EVENTOS);
  semErro(await db.from("event_log").delete().eq("organization_id", org).gte("id", e0).lte("id", e1), "limpar passagens do curso");
  // a clínica não tem linha de orçamento de fábrica: o gatilho de `llm_calls` cria uma na primeira chamada
  semErro(await db.from("ai_budgets").delete().eq("organization_id", org), "limpar orçamento da clínica");
}

export async function semear(c: Contexto) {
  await limpar(c);

  const jobs: Record<string, unknown>[] = [];
  const chamadas: Record<string, unknown>[] = [];
  let turno = 0;
  for (let d = 29; d >= 0; d--) {
    const dia = new Date(Date.parse(ha(d * DIA))).getUTCDay();
    const fimDeSemana = dia === 0 || dia === 6;
    const turnosNoDia = (fimDeSemana ? 9 : 22) + ((d * 7) % 5);
    for (let k = 0; k < turnosNoDia; k++) {
      turno++;
      // de 31 em 31 minutos para trás: nunca no futuro, e o dia de hoje cabe em 15h
      const em = ha(d * DIA + 20 + k * 31);
      const job = idEm(JOBS, turno);
      jobs.push({ id: job, organization_id: c.org, kind: "watchdog", status: "done", attempts: 1, run_after: em, created_at: em });

      const v = (turno * 37) % 100;
      const conversa = { entrada: 6_000 + v * 23, saida: 180 + ((turno * 13) % 200), cache: 4_200 + v * 14 };
      const partes: Array<{ purpose: string; modelo: Modelo; entrada: number; saida: number; cache: number; ms: number; doAgente?: true }> = [
        { purpose: "agent_turn", modelo: "claude-sonnet-4-6", ...conversa, ms: 2_600 + v * 26, doAgente: true },
        { purpose: "sentiment_classify", modelo: "claude-haiku-4-5", entrada: 520 + v * 2, saida: 18, cache: 0, ms: 420 + v * 4 },
      ];
      if (turno % 3 === 0) {
        partes.push({ purpose: "stage_classifier", modelo: "claude-haiku-4-5", entrada: 1_300 + v * 3, saida: 30, cache: 0, ms: 610 + v * 5 });
      }
      if (turno % 5 === 0) {
        partes.push({ purpose: "checkpoint", modelo: "claude-haiku-4-5", entrada: 2_400 + v * 6, saida: 190, cache: 0, ms: 1_100 + v * 8 });
      }
      for (const p of partes) {
        chamadas.push({
          id: idEm(CHAMADAS, chamadas.length + 1),
          organization_id: c.org,
          job_id: job,
          // o motor grava o agente só na chamada do turno; checkpoint e classificadores vão sem
          agent_id: p.doAgente ? c.agenteId : null,
          purpose: p.purpose,
          provider: "anthropic",
          model: p.modelo,
          input_tokens: p.entrada,
          output_tokens: p.saida,
          cache_read_tokens: p.cache,
          cache_write_tokens: 0,
          cost_cents: centavos(p.modelo, p.entrada, p.saida, p.cache),
          latency_ms: p.ms,
          status: "ok",
          created_at: em,
        });
      }
    }
  }

  for (let i = 0; i < jobs.length; i += 500) {
    semErro(await c.db.from("job_queue").insert(jobs.slice(i, i + 500)), "turnos da Bia");
  }
  for (let i = 0; i < chamadas.length; i += 500) {
    semErro(await c.db.from("llm_calls").insert(chamadas.slice(i, i + 500)), "chamadas de IA da Bia");
  }

  // duas passagens para uma pessoa nas últimas horas, já tratadas
  semErro(
    await c.db.from("event_log").insert(
      [
        { n: 1, conversa: 6, em: ha(190) },
        { n: 2, conversa: 3, em: ha(75) },
      ].map((e) => ({
        id: idEm(EVENTOS, e.n),
        organization_id: c.org,
        event_type: "ai.handoff_triggered",
        entity_kind: "conversation",
        entity_id: conversaId(e.conversa),
        payload: { conversation_id: conversaId(e.conversa) },
        status: "done",
        created_at: e.em,
        updated_at: e.em,
      })),
    ),
    "passagens para uma pessoa",
  );

  // o teto do mês: avisar ao passar de 80% de US$ 15 (o gatilho de `llm_calls` já criou a linha)
  semErro(
    await c.db.from("ai_budgets").upsert(
      {
        organization_id: c.org,
        monthly_limit_cents: 1_500,
        alarm_threshold_pct: 80,
        enforcement_mode: "avisar",
        enforcement_effective_at: null,
        last_alarm_sent_at: null,
      },
      { onConflict: "organization_id" },
    ),
    "orçamento de IA da clínica",
  );
}
