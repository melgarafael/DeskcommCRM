/**
 * Saúde da sessão WAHA pós-fusão. O watchdog de restart (admin-plane) é Fase 4;
 * o que o runtime precisa AGORA:
 *   - ler o status da sessão — fonte é a própria tabela channel_sessions do CRM
 *     (mesmo banco), mantida fresca pelo webhook session.status do WAHA. Regra
 *     dura nº 4 preservada: o message-plane lê a TABELA, nunca fala com o WAHA;
 *   - enforceHolds: reter jobs de envio de sessão fora do ar / em hold de saúde
 *     (health_hold_active vem do circuito de saúde em health/circuit.ts, que
 *     escreve channel_session_health).
 */
import type pg from 'pg';

import type { Queryable } from '../../queue/queue';

/** Status do WAHA em que a sessão consegue enviar (uppercase — contrato do CRM). */
export const SESSION_HEALTHY_STATUS = 'WORKING';

export const SESSION_ESCALATION_STATUSES = ['SCAN_QR_CODE', 'FAILED'] as const;

/** Job kinds que ENVIAM (retidos sob hold de sessão/saúde). */
const SEND_JOB_KINDS = ['inbound_turn', 'followup_turn'] as const;

/**
 * O envio que o NEGÓCIO inicia — follow-up agendado, cadência de prospecção.
 * É o que o hold de go-live existe para segurar.
 *
 * O irmão dele, `inbound_turn`, é RESPOSTA a quem acabou de escrever. Os dois
 * mandam mensagem pelo mesmo número, e é só por isso que estavam na mesma
 * regra — mas o risco que o aquecimento administra é o de disparar para quem
 * não pediu. Responder quem chamou não queima número; ficar mudo com o cliente
 * na tela queima o produto.
 */
const PROACTIVE_SEND_JOB_KIND = 'followup_turn';

/**
 * Retém jobs 'pending' de sessão não-WORKING ou sob hold de saúde (run_after =
 * infinity, com o run_after original guardado no payload) e libera quando a
 * sessão volta. Idempotente por construção (marcador held_run_after no payload).
 *
 * ─── O hold é REASON-AWARE, e antes só dizia que era ─────────────────────────
 * `health/circuit.ts` sempre descreveu esta primitiva como "reason-aware", mas
 * a regra aqui olhava só o booleano `health_hold_active`. Efeito medido numa
 * instalação real (2026-08-18): número novo nasce em hold `go_live` — que é
 * fail-safe e correto —, e com ele TODO `inbound_turn` da sessão ia para
 * `run_after = 'infinity'`. O lead mandava "Oi", a tela mostrava "IA
 * atendendo", o agente publicado nunca rodava, e o único sinal era um item de
 * Central marcado `info` falando de "outbound". Horas de silêncio com o
 * diagnóstico invisível.
 *
 * A distinção que a regra passa a fazer:
 *
 *   * `s.status <> 'WORKING'` — o canal está fora do ar. Retém TUDO: não existe
 *     mensagem que consiga sair, proativa ou não.
 *   * hold `go_live` — o número é novo e ainda não foi liberado pelo humano.
 *     Retém só o PROATIVO (`followup_turn`). Resposta a quem escreveu sai.
 *   * hold `block_rate` / `response_rate` — o número já está sendo bloqueado
 *     pelos destinatários. Retém TUDO, como antes: aqui a suspeita recai sobre
 *     o próprio número, e não só sobre a iniciativa do disparo.
 */
export async function enforceHolds(harness: pg.Pool): Promise<{ held: number; released: number }> {
  const hold = await harness.query(
    `update job_queue j
     set payload = jsonb_set(j.payload, '{held_run_after}', to_jsonb(j.run_after)),
         run_after = 'infinity'
     from channel_sessions s
     left join channel_session_health h
       on h.organization_id = s.organization_id and h.channel_session_id = s.id
     where (
             s.status <> $1
             or (
               coalesce(h.health_hold_active, false)
               and (h.health_hold_reason is distinct from 'go_live' or j.kind = $3)
             )
           )
       and j.organization_id = s.organization_id
       and j.status = 'pending'
       and j.kind = any($2::text[])
       and j.payload->>'channel_session_id' = s.id::text
       and not (j.payload ? 'held_run_after')`,
    [SESSION_HEALTHY_STATUS, [...SEND_JOB_KINDS], PROACTIVE_SEND_JOB_KIND],
  );
  const release = await harness.query(
    `update job_queue j
     set run_after = (j.payload->>'held_run_after')::timestamptz,
         payload = j.payload - 'held_run_after'
     from channel_sessions s
     left join channel_session_health h
       on h.organization_id = s.organization_id and h.channel_session_id = s.id
     where s.status = $1
       and (
         not coalesce(h.health_hold_active, false)
         or (h.health_hold_reason = 'go_live' and j.kind is distinct from $2)
       )
       and j.organization_id = s.organization_id
       and j.status = 'pending'
       and j.payload ? 'held_run_after'
       and j.payload->>'channel_session_id' = s.id::text`,
    [SESSION_HEALTHY_STATUS, PROACTIVE_SEND_JOB_KIND],
  );
  return { held: hold.rowCount ?? 0, released: release.rowCount ?? 0 };
}

/** Métrica de saúde por sessão — exposta no payload do /healthz do worker. */
export interface SessionHealthMetric {
  organization_id: string;
  channel_session_id: string;
  status: string;
  /** segundos desde a última atualização da sessão (aproximação do tempo no estado). */
  seconds_in_status: number;
  /** jobs de envio retidos pelo hold */
  held_jobs: number;
}

export async function sessionHealthMetrics(db: Queryable): Promise<SessionHealthMetric[]> {
  const { rows } = await db.query<SessionHealthMetric>(
    `select s.organization_id,
            s.id as channel_session_id,
            s.status,
            extract(epoch from (now() - s.updated_at))::int as seconds_in_status,
            (select count(*)::int from job_queue j
              where j.organization_id = s.organization_id
                and j.status = 'pending'
                and j.payload ? 'held_run_after'
                and j.payload->>'channel_session_id' = s.id::text) as held_jobs
     from channel_sessions s
     order by s.updated_at desc
     limit 50`,
  );
  return rows;
}
