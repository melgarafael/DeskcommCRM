/**
 * Semente do módulo "Uso e orçamento" (Agente de IA › Ver tudo em IA › Uso e orçamento).
 *
 * Na bancada a IA nunca é chamada (worker parado), e a tela de Uso só soma o
 * que está em `llm_calls`: sem esta semente ela mostraria tudo zerado. Aqui
 * fica gravado, do jeito que o motor grava
 * (`lib/agent-engine/edge/llm/run-model-call.ts`), um mês comum da Clínica Bem
 * Viver nos últimos 30 dias:
 *
 *  - os turnos da Bia (`agent_turn`, Anthropic `claude-sonnet-4-6`, com
 *    `agent_id` da Bia e o `job_id` do turno — é o par que a tela conta em
 *    "Turnos do agente"), com prefixo em cache na maioria deles;
 *  - os classificadores do turno no modelo econômico do provedor
 *    (`intent_router`, `stage_classifier`, no mesmo `job_id`) e o clima da
 *    conversa (`sentiment_classify`, fora de turno);
 *  - o custo de cada linha calculado pela MESMA tabela de preços do motor
 *    (`costCents` de `lib/agent-engine/edge/llm/pricing.ts`) — nunca custo
 *    nulo, que acenderia o aviso de "medição incompleta" no card;
 *  - os turnos na fila (`job_queue`, kind `inbound_turn`, já `done`: nenhum
 *    worker os pega);
 *  - duas passagens para uma pessoa hoje (`event_log` `ai.handoff_triggered`,
 *    já `done`), nas conversas da Mariana e do Roberto, as duas em que o
 *    cliente pediu gente na base — é o que o card "Passaram para uma pessoa" lê.
 *
 * O ORÇAMENTO: a base não tem linha em `ai_budgets`. A semente cria a linha da
 * Clínica em "Só acompanhar", sem limite (é o ponto de partida das lições), ANTES
 * das chamadas — senão o gatilho `trg_llm_calls_budget` a criaria com o
 * `DEFAULT 5000` da coluna. As lições mudam essa linha pela tela ("Me avisar",
 * "Parar a IA"); por isso `limpar` (chamada antes de QUALQUER aula) apaga a
 * linha e devolve a organização ao estado da base: sem orçamento.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos com o prefixo d1230000 em
 * `llm_calls`, d1230100 em `job_queue`, d1230200 em `event_log`) e recria, com
 * horários relativos à hora em que roda. Nenhum texto daqui aparece na tela —
 * por isso nada passa por `demo()`.
 */
import { costCents } from "../../lib/agent-engine/edge/llm/pricing";
import { type Contexto, contatoId, conversaId, semErro } from "../semear-demonstracao";

const chamadaId = (n: number) => `d1230000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const turnoId = (n: number) => `d1230100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const passagemId = (n: number) => `d1230200-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Todos os ids de um prefixo, para apagar por faixa (são centenas: um `in` estouraria a URL). */
const faixa = (prefixo: string) =>
  [`${prefixo}-0000-0000-0000-000000000000`, `${prefixo}-ffff-ffff-ffff-ffffffffffff`] as const;

const MIN = 60_000;
const DIA = 1_440 * MIN;
const DIAS = 30;
/** Os pacientes da base (a 10 é o grupo de Pilates: grupo nunca vai para a IA). */
const PACIENTES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12];

const MODELO_DO_AGENTE = "claude-sonnet-4-6";
const MODELO_ECONOMICO = "claude-haiku-5-5";

type Linha = Record<string, unknown>;

/** Limpeza chamada antes de QUALQUER aula: o consumo e o orçamento daqui não sobram em outra tela. */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  const [c0, c1] = faixa("d1230000");
  semErro(
    await db.from("llm_calls").delete().eq("organization_id", org).gte("id", c0).lte("id", c1),
    "limpar chamadas de IA do módulo",
  );
  const [t0, t1] = faixa("d1230100");
  semErro(
    await db.from("job_queue").delete().eq("organization_id", org).gte("id", t0).lte("id", t1),
    "limpar turnos do módulo",
  );
  const [p0, p1] = faixa("d1230200");
  semErro(
    await db.from("event_log").delete().eq("organization_id", org).gte("id", p0).lte("id", p1),
    "limpar passagens do módulo",
  );
  // A base não tem orçamento: a linha é desta semente (ou da lição que a mudou pela tela).
  semErro(
    await db.from("ai_budgets").delete().eq("organization_id", org),
    "limpar o orçamento de IA",
  );
}

/** Turnos num dia: dia útil tem mais movimento; a variação vem de conta fixa (sem acaso: a foto não muda entre capturas). */
function turnosNoDia(d: number, agora: number) {
  const semana = new Date(agora - d * DIA).getUTCDay();
  return semana === 0 || semana === 6 ? 6 + (d % 3) : 15 + ((d * 7) % 6);
}

export async function semear(c: Contexto) {
  const { db, org, agenteId } = c;
  await limpar(c);
  const agora = Date.now();

  // Antes das chamadas: com a linha já de pé, o gatilho só soma o consumo nela.
  semErro(
    await db.from("ai_budgets").insert({
      organization_id: org,
      monthly_limit_cents: 0,
      alarm_threshold_pct: 80,
      enforcement_mode: "off",
      enforcement_effective_at: null,
      current_month_consumed_cents: 0,
    }),
    "orçamento de IA da clínica",
  );

  const turnos: Linha[] = [];
  const chamadas: Linha[] = [];
  let nChamada = 0;
  const chamada = (l: {
    em: Date;
    purpose: string;
    model: string;
    entrada: number;
    saida: number;
    cacheLido?: number;
    cacheGravado?: number;
    ms: number;
    contato: string;
    job?: string;
    agente?: string;
    origem: string;
  }) => {
    const lido = l.cacheLido ?? 0;
    const gravado = l.cacheGravado ?? 0;
    chamadas.push({
      id: chamadaId(++nChamada),
      organization_id: org,
      contact_id: l.contato,
      job_id: l.job ?? null,
      agent_id: l.agente ?? null,
      purpose: l.purpose,
      provider: "anthropic",
      model: l.model,
      input_tokens: l.entrada,
      output_tokens: l.saida,
      cache_read_tokens: lido,
      cache_write_tokens: gravado,
      cost_cents: costCents(
        l.model,
        {
          inputTokens: l.entrada,
          outputTokens: l.saida,
          cacheReadTokens: lido,
          cacheWriteTokens: gravado,
        },
        "1h",
        l.em,
      ),
      latency_ms: l.ms,
      status: "ok",
      origem_da_escolha: l.origem,
      created_at: l.em.toISOString(),
    });
  };

  let nTurno = 0;
  for (let d = DIAS - 1; d >= 0; d--) {
    const n = turnosNoDia(d, agora);
    for (let j = 0; j < n; j++) {
      // de 34 em 34 min para trás a partir de "agora menos d dias": nunca no futuro
      const em = new Date(agora - d * DIA - (25 + j * 34) * MIN);
      const contato = contatoId(PACIENTES[(d * 5 + j) % PACIENTES.length]!);
      const job = turnoId(++nTurno);
      turnos.push({
        id: job,
        organization_id: org,
        contact_id: contato,
        kind: "inbound_turn",
        status: "done",
        attempts: 1,
        run_after: em.toISOString(),
        created_at: em.toISOString(),
      });

      // a primeira resposta de cada conversa grava o prefixo no cache; as seguintes leem
      const entrada = 7_200 + ((d * 131 + j * 977) % 2_800);
      const emCache = j % 4 === 0 ? 0 : 4_300 + ((d * 17 + j * 29) % 600);
      chamada({
        em,
        purpose: "agent_turn",
        model: MODELO_DO_AGENTE,
        entrada,
        saida: 170 + ((d * 37 + j * 53) % 230),
        cacheLido: emCache,
        cacheGravado: j % 4 === 0 ? 4_300 : 0,
        // a maioria entre 2,5 e 6 s; de vez em quando uma resposta com ferramenta demora mais
        ms: j % 9 === 4 ? 9_800 + ((d * 211) % 3_000) : 2_500 + ((d * 311 + j * 733) % 3_500),
        contato,
        job,
        agente: agenteId,
        origem: "agente_publicado",
      });
      if (j % 3 === 0)
        chamada({
          em: new Date(em.getTime() - 4_000),
          purpose: "intent_router",
          model: MODELO_ECONOMICO,
          entrada: 1_100 + ((d * 13 + j * 7) % 300),
          saida: 12,
          ms: 600 + ((d * 17 + j * 23) % 500),
          contato,
          job,
          origem: "economico_do_provedor",
        });
      if (j % 2 === 1)
        chamada({
          em: new Date(em.getTime() + 6_000),
          purpose: "stage_classifier",
          model: MODELO_ECONOMICO,
          entrada: 2_000 + ((d * 19 + j * 11) % 400),
          saida: 18,
          ms: 650 + ((d * 29 + j * 31) % 500),
          contato,
          job,
          origem: "economico_do_provedor",
        });
      if (j % 4 === 2)
        chamada({
          em: new Date(em.getTime() + 90_000),
          purpose: "sentiment_classify",
          model: MODELO_ECONOMICO,
          entrada: 900 + ((d * 23 + j * 5) % 250),
          saida: 8,
          ms: 500 + ((d * 7 + j * 13) % 400),
          contato,
          origem: "economico_do_provedor",
        });
    }
  }

  for (let i = 0; i < turnos.length; i += 400)
    semErro(await db.from("job_queue").insert(turnos.slice(i, i + 400)), "turnos da Bia na fila");
  for (let i = 0; i < chamadas.length; i += 400)
    semErro(await db.from("llm_calls").insert(chamadas.slice(i, i + 400)), "chamadas de IA do mês");

  // ---------- as duas passagens para uma pessoa de hoje (as conversas em que o cliente pediu gente) ----------
  semErro(
    await db.from("event_log").insert(
      [
        { n: 1, conversa: 1, minutos: 37, motivo: "requested_human" },
        { n: 2, conversa: 2, minutos: 11, motivo: "requested_human" },
      ].map((p) => ({
        id: passagemId(p.n),
        organization_id: org,
        event_type: "ai.handoff_triggered",
        entity_kind: "conversation",
        entity_id: conversaId(p.conversa),
        payload: {
          conversation_id: conversaId(p.conversa),
          organization_id: org,
          reason: p.motivo,
          lead_id: null,
          metadata: {},
        },
        metadata: { source: "handoff-orchestrator" },
        // já consumido: nenhum worker reage a esta passagem semeada
        status: "done",
        created_at: new Date(agora - p.minutos * MIN).toISOString(),
      })),
    ),
    "passagens para uma pessoa",
  );
}
