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

import type { PacingKnobs } from '../../pacing/defaults';
import { janelaDeEnvioAberta, proximaAberturaDaJanela } from '../../pacing/engine';
import { loadChannelKnobs } from '../../pacing/store';
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
 * O canal pelo qual o job vai SAIR — o mesmo a que o handler chega.
 *
 * `inbound_turn` traz `channel_session_id` no payload. O `followup_turn` não:
 * traz a conversa do atendimento (`service_boundary.conversation_id`, carimbada
 * por `fn_job_service_boundary`), e é por ela que `followup-turn.ts` acha o
 * canal. A regra casava só a chave do payload, e nenhum `followup_turn` real a
 * tem — então o hold de go-live, que existe para segurar exatamente esse job,
 * nunca o retinha, e o acompanhamento saía com o número ainda em hold. Sem
 * nenhum dos dois, o job não casa canal nenhum — e falha sozinho no handler,
 * que também não acharia para onde mandar.
 *
 * A conversa casa por TEXTO (`c.id::text`) de propósito: um `::uuid` sobre o
 * valor do payload lançaria `invalid input syntax` na rodada inteira se um job
 * trouxesse lixo, e o watchdog pararia de reter qualquer job.
 */
const CANAL_DO_JOB = `coalesce(
         j.payload->>'channel_session_id',
         (select c.channel_session_id::text from conversations c
           where c.organization_id = j.organization_id
             and c.contact_id = j.contact_id
             and c.id::text = j.payload #>> '{service_boundary,conversation_id}'))`;

/**
 * O canal que o hold usou fica no job (`held_channel_session_id`), e é por ele
 * que a liberação casa: recalcular pela conversa poderia não achar canal nenhum
 * se ela deixasse de casar durante o hold (outro canal, outro contato), e o job
 * nunca sairia. Job retido antes desta regra só tem `channel_session_id` — que é
 * justamente o que o reteve.
 */
const CANAL_DO_JOB_RETIDO = `coalesce(j.payload->>'held_channel_session_id', j.payload->>'channel_session_id')`;

/**
 * Intervalo entre dois retornos automáticos que voltam de uma retenção, no mesmo
 * número. ponytail: constante; vira knob por número em `channel_knobs` no dia em
 * que um operador precisar de outro ritmo.
 */
export const INTERVALO_ENTRE_RETIDOS_MS = 5 * 60_000;

/**
 * Para quando os retornos retidos de UM número voltam, na ordem em que estavam
 * marcados (`devidos` em ordem crescente).
 *
 * Devolver a cada um o horário original — que já passou — punha todos na fila
 * para o mesmo instante, e o número recém-liberado saía disparando em
 * sequência: o perfil que o WhatsApp bane (doc 109). Aqui cada um sai no seu
 * horário ou, se o anterior ainda estiver perto, `intervaloMs` depois dele; e
 * o que cair fora da janela de disparo vai para a abertura dela, em vez de ser
 * adiado pelo envio e se amontoar com os outros na abertura.
 */
export function espacarRetidos(
  devidos: Date[],
  agora: Date,
  knobs: PacingKnobs,
  intervaloMs: number = INTERVALO_ENTRE_RETIDOS_MS,
): Date[] {
  let livre = agora.getTime();
  return devidos.map((devido) => {
    let quando = new Date(Math.max(devido.getTime(), livre));
    if (!janelaDeEnvioAberta(quando, knobs)) {
      quando = proximaAberturaDaJanela(quando, knobs, false, () => 0);
    }
    livre = quando.getTime() + intervaloMs;
    return quando;
  });
}

interface JobLiberado {
  id: string;
  organization_id: string;
  kind: string;
  canal: string;
  /** `infinity` chega do driver como número, não Date. */
  run_after: Date | number;
  agora: Date;
}

/** Reagenda, espaçados por número, os retornos automáticos que acabaram de ser liberados. */
async function espacarLiberados(db: Queryable, liberados: JobLiberado[]): Promise<void> {
  const porCanal = new Map<string, Array<{ id: string; devido: Date }>>();
  for (const job of liberados) {
    if (job.kind !== PROACTIVE_SEND_JOB_KIND || !(job.run_after instanceof Date)) continue;
    const chave = `${job.organization_id}:${job.canal}`;
    porCanal.set(chave, [...(porCanal.get(chave) ?? []), { id: job.id, devido: job.run_after }]);
  }
  const ids: string[] = [];
  const quando: string[] = [];
  for (const [chave, jobs] of porCanal) {
    const [org, canal] = chave.split(':') as [string, string];
    jobs.sort((a, b) => a.devido.getTime() - b.devido.getTime() || a.id.localeCompare(b.id));
    const { knobs } = await loadChannelKnobs(db, org, canal);
    const agenda = espacarRetidos(jobs.map((j) => j.devido), liberados[0]!.agora, knobs);
    jobs.forEach((job, i) => {
      const at = agenda[i]!;
      if (at.getTime() === job.devido.getTime()) return;
      ids.push(job.id);
      quando.push(at.toISOString());
    });
  }
  if (ids.length === 0) return;
  await db.query(
    `update job_queue j set run_after = x.at
     from unnest($1::uuid[], $2::timestamptz[]) as x(id, at)
     where j.id = x.id`,
    [ids, quando],
  );
}

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
 *
 * O canal do job é achado por `CANAL_DO_JOB` (o payload, ou a conversa do
 * atendimento), e o que o hold usou fica em `held_channel_session_id` para a
 * liberação soltar o mesmo job. Na liberação, os retornos automáticos voltam
 * espaçados (`espacarRetidos`); a resposta a quem escreveu volta na hora.
 */
export async function enforceHolds(harness: pg.Pool): Promise<{ held: number; released: number }> {
  const hold = await harness.query(
    `update job_queue j
     set payload = jsonb_set(j.payload, '{held_run_after}', to_jsonb(j.run_after))
                   || jsonb_build_object('held_channel_session_id', s.id::text),
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
       and ${CANAL_DO_JOB} = s.id::text
       and not (j.payload ? 'held_run_after')`,
    [SESSION_HEALTHY_STATUS, [...SEND_JOB_KINDS], PROACTIVE_SEND_JOB_KIND],
  );
  // Liberar e espaçar na MESMA transação: entre os dois passos o job ficaria
  // `pending` com o horário original, já passado, e o worker o pegaria antes
  // do espaçamento (a fila trava por FOR UPDATE SKIP LOCKED, e a linha que esta
  // transação atualizou fica travada até o commit).
  const client = await harness.connect();
  try {
    await client.query('begin');
    const release = await client.query<JobLiberado>(
      `update job_queue j
       set run_after = (j.payload->>'held_run_after')::timestamptz,
           payload = j.payload - 'held_run_after' - 'held_channel_session_id'
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
         and ${CANAL_DO_JOB_RETIDO} = s.id::text
       returning j.id, j.organization_id, j.kind, s.id::text as canal, j.run_after, now() as agora`,
      [SESSION_HEALTHY_STATUS, PROACTIVE_SEND_JOB_KIND],
    );
    await espacarLiberados(client, release.rows);
    await client.query('commit');
    return { held: hold.rowCount ?? 0, released: release.rowCount ?? 0 };
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      throw new AggregateError([err, rollbackErr], 'rollback falhou ao liberar jobs retidos');
    }
    throw err;
  } finally {
    client.release();
  }
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
                and ${CANAL_DO_JOB_RETIDO} = s.id::text) as held_jobs
     from channel_sessions s
     order by s.updated_at desc
     limit 50`,
  );
  return rows;
}
