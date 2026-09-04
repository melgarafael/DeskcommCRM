/**
 * Drain pós-fusão: consome `ai_agent.dispatch_requested` do event_log (MESMO
 * banco — a role vendaval_drain e o transporte cross-banco morreram) e enfileira
 * jobs `inbound_turn` na fila durável do harness.
 *
 * Garantias:
 *   - organization_id vem da LINHA do evento (fonte confiável), nunca do payload;
 *   - at-least-once + dedup: claim CAS (pending→processing) + unique
 *     (organization_id, source_event_id) em job_queue com captura de 23505;
 *   - coalescência de rajada: mensagens do MESMO contato dentro da janela de
 *     debounce viram UM job (o turno lê o histórico completo e responde a todas);
 *   - grupos @g.us: skip (regra dura nº 12) — evento marcado done sem job;
 *   - eventos 'processing' órfãos (crash do worker) voltam a 'pending' por timeout.
 */
import { z } from 'zod';
import type pg from 'pg';

import type { Logger } from '../../obs/logger';
import { enqueueJob } from '../../queue/queue';
import { TIPOS_DERIVAVEIS, DERIVACAO_TERMINADA } from '@/lib/messaging/media/derivable';

const DRAIN_CONSUMER = 'agent-engine';

const dispatchPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    inbound_message_id: z.string().uuid(),
  })
  .passthrough();

interface EventRow {
  id: string;
  organization_id: string;
  payload: unknown;
  attempts: number;
  created_at: string;
}

export interface DrainKnobs {
  batchSize: number;
  intervalMs: number;
  idleIntervalMs: number;
  /** Janela de coalescência de rajada inbound por contato (0 = sem debounce). */
  debounceMs: number;
  /** Evento 'processing' órfão volta a 'pending' após isto. */
  reapTimeoutMs: number;
}

/** Um tick do drain: claima um lote de eventos e os transforma em jobs. */
export async function drainTick(
  pool: pg.Pool,
  knobs: DrainKnobs,
  log: Logger,
): Promise<number> {
  // Reaper de eventos órfãos — barato (update indexado), roda a cada tick.
  await pool.query(
    `update event_log set status = 'pending', updated_at = now()
     where event_type = 'ai_agent.dispatch_requested'
       and status = 'processing'
       and $1 = any(consumed_by)
       and updated_at < now() - make_interval(secs => $2 / 1000.0)`,
    [DRAIN_CONSUMER, knobs.reapTimeoutMs],
  );

  const { rows: events } = await pool.query<EventRow>(
    `update event_log e
     set status = 'processing', attempts = e.attempts + 1,
         consumed_by = array_append(array_remove(coalesce(e.consumed_by, '{}'), $2), $2),
         updated_at = now()
     where e.id in (
       select id from event_log
       where event_type = 'ai_agent.dispatch_requested'
         and status = 'pending'
         and (next_attempt_at is null or next_attempt_at <= now())
       order by created_at
       limit $1
       for update skip locked
     )
     returning e.id, e.organization_id, e.payload, e.attempts, e.created_at`,
    [knobs.batchSize, DRAIN_CONSUMER],
  );

  for (const event of events) {
    try {
      const desfecho = await processEvent(pool, event, knobs, log);
      if (desfecho === 'adiar') {
        // Adiar NÃO é falha: volta a pending com uma espera curta e não gasta
        // o orçamento de tentativas (que existe para erro de verdade).
        await pool.query(
          `update event_log
           set status = 'pending', attempts = greatest(attempts - 1, 0),
               next_attempt_at = now() + make_interval(secs => $2 / 1000.0), updated_at = now()
           where id = $1`,
          [event.id, ESPERA_DERIVACAO_MS],
        );
        continue;
      }
      await pool.query(
        `update event_log set status = 'done', updated_at = now() where id = $1`,
        [event.id],
      );
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      const terminal = event.attempts >= 5;
      await pool.query(
        `update event_log
         set status = $2, last_error = $3, next_attempt_at = now() + interval '30 seconds',
             updated_at = now()
         where id = $1`,
        [event.id, terminal ? 'dead' : 'pending', message],
      );
      log.error('drain: evento falhou', { event_id: event.id, terminal, error: message });
    }
  }
  return events.length;
}

/** Quanto esperar entre uma checagem e outra da derivação de mídia. */
const ESPERA_DERIVACAO_MS = 4_000;
/**
 * Teto da espera. Passado isto o turno segue SEM o texto derivado: melhor uma
 * resposta tarde e sem transcrição do que cliente esperando para sempre porque
 * a derivação travou.
 *
 * Era 45s até 2026-09-03, quando um áudio real (cliente "Alfran") levou ~86s
 * para transcrever: o turno estourou o teto, respondeu "não consegui ouvir
 * seu áudio" às 14:25:46, e a transcrição correta só ficou pronta às 14:26:04
 * — 18s tarde demais, e o cliente teve que digitar a pergunta de novo.
 * Medição de p50/p90/p99 de conclusão de transcrição nos últimos 7 dias desta
 * instalação: 14s / 407s / 2538s — a cauda longa (minutos) é de retry após
 * falha transitória, não do Whisper em si, e nenhum teto razoável a cobre sem
 * o cliente esperando minutos pela primeira resposta. 120s cobre o caso comum
 * de transcrição lenta (como o do Alfran) sem impor essa espera longa.
 */
const TETO_ESPERA_DERIVACAO_MS = 120_000;

type DesfechoEvento = 'processado' | 'adiar';

async function processEvent(
  pool: pg.Pool,
  event: EventRow,
  knobs: DrainKnobs,
  log: Logger,
): Promise<DesfechoEvento> {
  const parsed = dispatchPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    // Payload fora do contrato do ingest — evento é descartável (processed), não
    // retryável: re-tentar não conserta shape.
    log.warn('drain: payload de dispatch fora do contrato — evento descartado', {
      event_id: event.id,
    });
    return 'processado';
  }
  const p = parsed.data;

  // Spec 14: org em modo 'external' tem agente EXTERNO como dono da conversa —
  // o engine não responde por cima. Evento é consumido (done) sem job.
  const { rows: modeRows } = await pool.query<{ mode: string | null }>(
    `select settings->>'ai_dispatch_mode' as mode from organizations where id = $1`,
    [event.organization_id],
  );
  if (modeRows[0]?.mode === 'external') {
    log.info('drain: org em modo external (spec 14) — evento pulado', { event_id: event.id });
    return 'processado';
  }

  // Grupos: skip, sem exceção (regra dura nº 12).
  const { rows: convRows } = await pool.query<{ is_group: boolean }>(
    'select is_group from conversations where organization_id = $1 and id = $2',
    [event.organization_id, p.conversation_id],
  );
  if (convRows[0]?.is_group !== false) {
    log.info('drain: conversa de grupo ou inexistente — evento pulado', { event_id: event.id });
    return 'processado';
  }

  // Ninguém para atender: NÃO gastar. Sem agente publicado para esta sessão e
  // sem roteador que possa resolver alguém, o turno seguia assim mesmo e caía
  // no caminho genérico — rodando o pipeline inteiro e pagando por ele.
  //
  // Medido nesta VPS com o agente PAUSADO (despublicado pela tela): uma única
  // mensagem gastou 6 chamadas ao LLM, ~2 centavos, e ainda produziu resposta.
  // Multiplicado por toda mensagem que chega, com o agente desligado, é dinheiro
  // saindo sem ninguém ter pedido nada — e "pausei o agente" tem que significar
  // "parou de gastar".
  //
  // Também cobre a instalação recém-feita que ainda não configurou agente
  // nenhum: hoje ela pagaria por cada mensagem recebida.
  //
  // Roteador com membro PUBLICADO ou fallback PUBLICADO continua passando: ali
  // existe quem atenda, e o caminho genérico de "classificou e não bateu" segue
  // valendo.
  //
  // Este parágrafo dizia "roteador COM membros ou COM fallback", e a diferença
  // não é de redação: pausar um agente não apaga a linha dele em
  // `ai_router_members` nem zera `ai_routers.fallback_agent_id`. Medir a
  // EXISTÊNCIA da linha deixava o portão aberto para um roteador cujos membros
  // foram todos pausados — exatamente o caso que o parágrafo acima diz estar
  // cobrindo, entrando pela outra porta.
  const { rows: capacidade } = await pool.query<{
    tem_agente: boolean;
    tem_roteador: boolean;
  }>(
    `select
       exists(
         select 1 from ai_agents a
         join ai_agent_versions v on v.id = a.published_version_id
         where a.organization_id = $1 and a.archived_at is null
           and v.status = 'published' and v.channel_session_id = $2
       ) as tem_agente,
       exists(
         select 1 from ai_routers r
         where r.organization_id = $1 and r.is_active
           and r.channel_session_id = $2
           and (
             -- O fallback e os membros contam pelo que PODEM EXECUTAR, não por
             -- existirem. A versão anterior media fallback_agent_id is not null
             -- e a existência de LINHA em ai_router_members — e as duas
             -- sobrevivem à pausa do agente, que só limpa published_version_id.
             -- Um roteador cujos membros foram todos pausados continuava
             -- abrindo o portão: a organização pagava o classificador e o turno
             -- inteiro por mensagem recebida, para responder pelo genérico.
             -- O predicado aqui é o MESMO que loadPublishedAgentConfigById
             -- aplica na hora de executar (agent-config.ts) — é o que garante
             -- que o portão não promete um agente que o resolvedor vai recusar.
             exists (
               select 1 from ai_agents fa
               join ai_agent_versions fv on fv.id = fa.published_version_id
               where fa.id = r.fallback_agent_id and fa.organization_id = $1
                 and fa.archived_at is null and fv.status = 'published'
             )
             or exists (
               select 1 from ai_router_members m
               join ai_agents ma on ma.id = m.agent_id
               join ai_agent_versions mv on mv.id = ma.published_version_id
               where m.router_id = r.id and ma.organization_id = $1
                 and ma.archived_at is null and mv.status = 'published'
             )
           )
       ) as tem_roteador`,
    [event.organization_id, p.channel_session_id],
  );
  const cap = capacidade[0];
  if (cap !== undefined && !cap.tem_agente && !cap.tem_roteador) {
    log.info('drain: nenhum agente publicado para a sessão — turno pulado (sem gasto)', {
      event_id: event.id,
      channel_session_id: p.channel_session_id,
    });
    return 'processado';
  }

  // Mídia ainda virando texto: ESPERAR. Sem isto o turno era despachado no mesmo
  // instante em que a mensagem chegava, enquanto o áudio ainda estava sendo
  // baixado e transcrito — e o cliente recebia "recebi seu áudio, mas não
  // consigo ouvi-lo" segundos ANTES de a transcrição ficar pronta. Medido nesta
  // VPS: dispatch às 20:24:22, derivação só pedida às 20:25:03.
  const { rows: msgRows } = await pool.query<{
    type: string;
    media_derived_status: string | null;
  }>(
    `select type, media_derived_status from messages
     where organization_id = $1 and id = $2`,
    [event.organization_id, p.inbound_message_id],
  );
  const msg = msgRows[0];
  if (
    msg !== undefined &&
    TIPOS_DERIVAVEIS.has(msg.type) &&
    !DERIVACAO_TERMINADA.has(msg.media_derived_status ?? '')
  ) {
    const esperandoHa = Date.now() - new Date(event.created_at).getTime();
    if (esperandoHa < TETO_ESPERA_DERIVACAO_MS) {
      log.info('drain: mídia ainda sendo transcrita — turno adiado', {
        event_id: event.id,
        tipo: msg.type,
        esperando_ha_ms: esperandoHa,
      });
      return 'adiar';
    }
    log.warn('drain: derivação não concluiu no teto — seguindo sem o texto', {
      event_id: event.id,
      tipo: msg.type,
      esperando_ha_ms: esperandoHa,
    });
  }

  // Coalescência: já existe job PENDING futuro deste contato → esta mensagem
  // entra de carona (o turno lê o histórico completo). Evento vira done.
  if (knobs.debounceMs > 0) {
    const { rows: pendingRows } = await pool.query<{ id: string }>(
      `select id from job_queue
       where organization_id = $1 and contact_id = $2
         and kind = 'inbound_turn' and status = 'pending' and run_after > now()
       limit 1`,
      [event.organization_id, p.contact_id],
    );
    if (pendingRows[0]) {
      log.info('drain: rajada coalescida em job pendente', {
        event_id: event.id,
        job_id: pendingRows[0].id,
      });
      return 'processado';
    }
  }

  const runAfter = knobs.debounceMs > 0 ? new Date(Date.now() + knobs.debounceMs) : undefined;
  const { job, deduped } = await enqueueJob(pool, event.organization_id, {
    kind: 'inbound_turn',
    leadId: p.contact_id,
    sourceEventId: event.id,
    payload: {
      conversation_id: p.conversation_id,
      contact_id: p.contact_id,
      channel_session_id: p.channel_session_id,
      inbound_message_id: p.inbound_message_id,
      crm_event_id: event.id,
    },
    ...(runAfter !== undefined ? { runAfter } : {}),
  });
  log.info('drain: job de turno enfileirado', { event_id: event.id, job_id: job.id, deduped });
  return 'processado';
}

/** Loop do drain — polling com backoff adaptativo (ocioso = tick mais lento). */
export async function runDrainLoop(
  pool: pg.Pool,
  knobs: DrainKnobs,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let drained = 0;
    try {
      drained = await drainTick(pool, knobs, log);
    } catch (err) {
      log.error('drain: tick falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
    const waitMs = drained > 0 ? knobs.intervalMs : knobs.idleIntervalMs;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
