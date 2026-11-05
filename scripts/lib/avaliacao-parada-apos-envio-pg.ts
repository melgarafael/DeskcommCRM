/**
 * O lado de BANCO da avaliação da parada após envio que decide dinheiro: o gasto
 * que o teto do `executar` soma e os retornos que o lote deixa agendados. Fica
 * fora do roteiro para ser provado contra Postgres real
 * (tests/invariants/avaliacao-parada-lote-so-o-dele.test.ts); a parte pura mora em
 * `./avaliacao-parada-apos-envio.ts`, e quem chama é
 * `scripts/avaliar-parada-apos-envio.ts`.
 */
import type pg from "pg";

import { cancelaRetorno } from "@/lib/followup/retorno";
import { criaRetornoDbPg } from "@/lib/followup/retorno-pg";

import { padraoDoLote, type GastoDoLote } from "./avaliacao-parada-apos-envio";

export const NOME_DO_AGENTE = "Avaliação da parada após envio";

/**
 * O gasto do lote em `llm_calls`: as chamadas dos contatos do lote (este e os
 * `executar` anteriores do mesmo lote) e, das sem contato, só as do agente da
 * avaliação desde o início desta invocação — o classificador de sentimento do
 * turno grava `agent_id` e não grava `contact_id`.
 *
 * Sem contato e sem agente é de OUTRO processo: a prévia dos agentes da
 * avaliação de tokens (`agent_preview` e seus auxiliares, medido no piloto de
 * 03/11) roda na mesma organização ao mesmo tempo, e somada aqui faria o teto do
 * lote parar pelo gasto alheio — ou, com custo nulo, acusar cegueira que não é
 * dele. O agente é achado pelo nome na organização da sessão, como no `preparar`.
 */
export async function gastoDoLote(pool: pg.Pool, lote: number, desde: Date, sessao: string): Promise<GastoDoLote> {
  const { rows } = await pool.query<{ centavos: number; cegas: number }>(
    `select coalesce(sum(lc.cost_cents), 0)::float8 as centavos,
            (count(*) filter (where coalesce(lc.input_tokens, 0) + coalesce(lc.output_tokens, 0) > 0
                                and coalesce(lc.cost_cents, 0) = 0))::int as cegas
       from llm_calls lc
       left join contacts c on c.id = lc.contact_id
      where (c.id is not null and regexp_replace(c.phone_number, '\\D', '', 'g') ~ $1)
         or (lc.contact_id is null and lc.created_at >= $2
             and lc.agent_id in (select a.id from ai_agents a
                                   join channel_sessions s on s.organization_id = a.organization_id
                                  where s.waha_session_name = $3 and a.name = $4))`,
    [padraoDoLote(lote), desde, sessao, NOME_DO_AGENTE],
  );
  return { centavos: rows[0]?.centavos ?? 0, chamadasCegas: rows[0]?.cegas ?? 0 };
}

export const MOTIVO_DO_CANCELAMENTO = "avaliação da parada: retorno de contato de teste, cancelado pelo roteiro";

/**
 * Cancela os retornos que os turnos do lote agendaram. S2 pede "me chama amanhã
 * às 10h", o modelo agenda de verdade (`cron_jobs` followup_turn), e o worker os
 * dispararia no dia seguinte como turnos PAGOS, fora de qualquer teto.
 *
 * Pela regra do produto (`cancelaRetorno`, a mesma da tela e do agente, sobre o
 * adaptador `pg` do motor), nunca por UPDATE próprio. Só retornos de contato do
 * lote; os de qualquer outro contato ficam. Devolve quantos cancelou.
 */
export async function cancelarRetornosDoLote(pool: pg.Pool, lote: number, agora: Date): Promise<number> {
  const { rows } = await pool.query<{ id: string; organization_id: string }>(
    `select j.id, j.organization_id
       from cron_jobs j
       join contacts c on c.id = j.contact_id and c.organization_id = j.organization_id
      where j.kind = 'at' and j.job_kind = 'followup_turn' and j.enabled
        and regexp_replace(c.phone_number, '\\D', '', 'g') ~ $1`,
    [padraoDoLote(lote)],
  );
  const db = criaRetornoDbPg(pool);
  let cancelados = 0;
  for (const r of rows) {
    const feito = await cancelaRetorno(db, { agora }, { orgId: r.organization_id, retornoId: r.id }, { motivo: MOTIVO_DO_CANCELAMENTO });
    if (feito.ok) cancelados += 1;
  }
  return cancelados;
}
