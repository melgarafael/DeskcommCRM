/**
 * Circuito de saúde do número (F2-26; blueprint risco nº 1, achado 5.2). Tick
 * periódico que, por número/sessão, computa em janela móvel (knobs) o block rate e o
 * response rate e decide HOLD/UNHOLD de outbound — mitigação ATIVA do risco de ban.
 *
 * É um tick PRÓPRIO (runHealthLoop no main.ts), separado do watchdog (F2-14): a saúde
 * de entregabilidade é uma dimensão ORTOGONAL ao status-WORKING (um número WORKING
 * pode estar queimando). Reusa a primitiva de hold da F2-14 (enforceHolds, reason-
 * aware): o job fica retido sob QUALQUER hold e só é liberado quando NENHUM está
 * ativo — os dois nunca brigam pelo run_after. A fila RETÉM, nunca dropa (ban é
 * operação normal; segurar é não-destrutivo — o humano resolve).
 *
 * Fontes HONESTAS (só o que já é drenado/medido — nada inventado):
 *   - block rate = send_ledger.status='vetoed' (is_blocked, F2-06) / total de
 *     tentativas de outbound do número na janela. Atribuição ao número: exists em
 *     conversations (contact_id + channel_session_id, is_group=false) — o vínculo
 *     durável contato↔sessão no CRM. É o sinal por-envio do "outbound que virou
 *     is_blocked"; contacts.is_blocked é o estado por-contato.
 *   - response rate = contatos (do número) contatados (send_ledger 'accepted') que
 *     responderam (evento ai_agent.dispatch_requested no event_log, F2-05) / contatados.
 *     ponytail: é um PROXY (janela grosseira; conversa iniciada por inbound infla o
 *     numerador) — por isso responseRateFloor nasce 0 (off, opt-in por número). Só
 *     vira circuito quando o operador o calibra com dado real; até lá é só observado.
 *
 * Estado (channel_session_health, 0012): health_hold_active + reason + held_at (base
 * do cool-down) + released_at (NULL = número novo, nunca liberado → nasce em hold).
 * Retomada: MANUAL (humano resolve o inbox_item → o próximo tick libera) ou
 * AUTOMÁTICA (cool-down decorrido E métricas recuperadas → libera e auto-resolve o
 * item). Número novo (born-held) só libera manualmente — a liberação inicial é ato
 * explícito de go-live (o gate F4-10 usa exatamente este mecanismo).
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type pg from 'pg';

import type { Logger } from '../obs/logger';
import { enforceHolds } from '../edge/crm/session-watchdog';
import { HEALTH_DEFAULTS, type HealthKnobs } from './defaults';

/** ref_kind do inbox_item de saúde — o discriminador do episódio (dedup) e o alvo (ref_id=session). */
export const HEALTH_HOLD_REF_KIND = 'number_health';

type HoldReason = 'go_live' | 'block_rate' | 'response_rate';

/** Mesma disciplina do normalizeError da fila: 1ª linha truncada — PII fora. */
function errMsg(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split('\n', 1)[0] ?? '').slice(0, 300);
}

/**
 * Valida o shape do jsonb de knobs (defesa em profundidade com o CHECK da 0012, que
 * só garante "é objeto"). Não-objeto → null (o load usa defaults + warn); objeto →
 * merge por campo sobre os defaults conservadores. Espelha spinning/store.ts.
 */
function parseHealthKnobs(value: unknown): HealthKnobs | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    windowMs: num(o.windowMs, HEALTH_DEFAULTS.windowMs),
    blockRateThreshold: num(o.blockRateThreshold, HEALTH_DEFAULTS.blockRateThreshold),
    blockRateMinSends: num(o.blockRateMinSends, HEALTH_DEFAULTS.blockRateMinSends),
    responseRateFloor: num(o.responseRateFloor, HEALTH_DEFAULTS.responseRateFloor),
    responseRateMinSends: num(o.responseRateMinSends, HEALTH_DEFAULTS.responseRateMinSends),
    cooldownMs: num(o.cooldownMs, HEALTH_DEFAULTS.cooldownMs),
  };
}

/** Knobs efetivos do número: `channel_knobs.health_knobs` sobre os defaults. */
export async function loadHealthKnobs(
  db: pg.Pool,
  tenantId: string,
  channelSessionId: string,
  logger?: Logger,
): Promise<HealthKnobs> {
  const { rows } = await db.query<{ health_knobs: unknown }>(
    `select health_knobs from channel_knobs where organization_id = $1 and channel_session_id = $2`,
    [tenantId, channelSessionId],
  );
  const raw = rows[0]?.health_knobs;
  if (raw === null || raw === undefined) return { ...HEALTH_DEFAULTS };
  const parsed = parseHealthKnobs(raw);
  if (!parsed) {
    logger?.warn('health_knobs inválido em channel_knobs — usando defaults conservadores', {
      tenantId,
      channelSessionId,
    });
    return { ...HEALTH_DEFAULTS };
  }
  return parsed;
}

interface SessionRates {
  totalSends: number;
  blockedSends: number;
  sentLeads: number;
  respondedLeads: number;
}

/**
 * Computa block/response rate do número na janela — só de fontes já drenadas/medidas.
 * Atribuição send_ledger→número: `exists` em conversations (contact_id +
 * channel_session_id, is_group=false) — send_ledger não guarda a sessão; a
 * conversa 1:1 do contato no número é o vínculo durável. Inbound via evento
 * ai_agent.dispatch_requested no event_log do CRM (payload.channel_session_id/
 * contact_id — as chaves que lib/waha/ingest.ts emite).
 */
async function computeSessionRates(
  db: pg.Pool,
  tenantId: string,
  channelSessionId: string,
  windowMs: number,
): Promise<SessionRates> {
  const { rows } = await db.query<{
    total_sends: number;
    blocked_sends: number;
    sent_leads: number;
    responded_leads: number;
  }>(
    `with cut as (select now() - ($3 * interval '1 millisecond') as t)
     select
       (select count(*) from send_ledger sl
          where sl.organization_id = $1 and sl.created_at >= (select t from cut)
            and exists (
              select 1 from conversations c
              where c.organization_id = $1 and c.contact_id = sl.contact_id
                and c.channel_session_id = $2::uuid and c.is_group = false))::int as total_sends,
       (select count(*) from send_ledger sl
          where sl.organization_id = $1 and sl.status = 'vetoed'
            and sl.created_at >= (select t from cut)
            and exists (
              select 1 from conversations c
              where c.organization_id = $1 and c.contact_id = sl.contact_id
                and c.channel_session_id = $2::uuid and c.is_group = false))::int as blocked_sends,
       (select count(distinct sl.contact_id) from send_ledger sl
          where sl.organization_id = $1 and sl.status = 'accepted'
            and sl.created_at >= (select t from cut)
            and exists (
              select 1 from conversations c
              where c.organization_id = $1 and c.contact_id = sl.contact_id
                and c.channel_session_id = $2::uuid and c.is_group = false))::int as sent_leads,
       (select count(distinct sl.contact_id) from send_ledger sl
          where sl.organization_id = $1 and sl.status = 'accepted'
            and sl.created_at >= (select t from cut)
            and exists (
              select 1 from conversations c
              where c.organization_id = $1 and c.contact_id = sl.contact_id
                and c.channel_session_id = $2::uuid and c.is_group = false)
            and exists (
              select 1 from event_log e
              where e.organization_id = $1 and e.event_type = 'ai_agent.dispatch_requested'
                and e.payload->>'channel_session_id' = $2::text
                and (e.payload->>'contact_id')::uuid = sl.contact_id
                and e.created_at >= (select t from cut)))::int as responded_leads`,
    [tenantId, channelSessionId, windowMs],
  );
  const r = rows[0];
  return {
    totalSends: r?.total_sends ?? 0,
    blockedSends: r?.blocked_sends ?? 0,
    sentLeads: r?.sent_leads ?? 0,
    respondedLeads: r?.responded_leads ?? 0,
  };
}

/** Percentual legível para o diagnóstico (fora de qualquer linha com literal de saúde). */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/** Texto do diagnóstico do inbox_item (pt-br; SÓ taxas/contagens — PII jamais). */
function diagnosisBody(reason: HoldReason, rates: SessionRates, k: HealthKnobs): string {
  if (reason === 'go_live') {
    return (
      'Número novo aguardando liberação (go-live). O outbound nasce em espera por segurança: ' +
      'a fila retém as mensagens, nada é perdido. Resolva este item quando o número estiver pronto para disparar.'
    );
  }
  if (reason === 'block_rate') {
    const rate = rates.totalSends > 0 ? rates.blockedSends / rates.totalSends : 0;
    return (
      `Bloqueios em ${pct(rate)} dos ${rates.totalSends} últimos envios do número ` +
      `(limiar ${pct(k.blockRateThreshold)}). Outbound em espera automática — a fila retém, nada é perdido. ` +
      'Verifique o número (possível queima do WhatsApp) e resolva este item para retomar.'
    );
  }
  const rate = rates.sentLeads > 0 ? rates.respondedLeads / rates.sentLeads : 0;
  return (
    `Taxa de resposta em ${pct(rate)} (${rates.respondedLeads} de ${rates.sentLeads} leads contatados ` +
    `responderam; piso ${pct(k.responseRateFloor)}). Outbound em espera automática — a fila retém. ` +
    'Verifique a abordagem/o número e resolva este item para retomar.'
  );
}

export interface HealthTickResult {
  /** sessões avaliadas neste tick */
  evaluated: number;
  /** sessões que ENTRARAM em health-hold neste tick */
  held: number;
  /** sessões que SAÍRAM de health-hold neste tick (manual ou cool-down) */
  released: number;
  /** agent_inbox_items(number_health) inseridos (dedup por episódio) */
  alerts: number;
  /** jobs de envio retidos pelo enforce deste tick (F2-14, reason-aware) */
  jobsHeld: number;
  /** jobs de envio liberados pelo enforce deste tick */
  jobsReleased: number;
}

interface HealthRow {
  health_hold_active: boolean;
  health_released_at: Date | null;
  cooldown_elapsed: boolean;
  has_open_item: boolean;
}

/**
 * Decide e aplica a transição de UMA sessão sob lock (FOR UPDATE) — dois ticks
 * concorrentes serializam na row do espelho, então nunca duplicam item nem hold.
 * Devolve o delta {held, released, alerts} desta sessão.
 */
async function evaluateSession(
  harness: pg.Pool,
  tenantId: string,
  channelSessionId: string,
  rates: SessionRates,
  k: HealthKnobs,
): Promise<{ held: number; released: number; alerts: number }> {
  const delta = { held: 0, released: 0, alerts: 0 };
  const client = await harness.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<HealthRow>(
      `select
         h.health_hold_active,
         h.health_released_at,
         (h.health_held_at is not null and now() - h.health_held_at >= ($3 * interval '1 millisecond'))
           as cooldown_elapsed,
         exists (
           select 1 from agent_inbox_items i
           where i.organization_id = h.organization_id and i.ref_kind = $4 and i.ref_id = h.channel_session_id
             and i.status = 'open'
         ) as has_open_item
       from channel_session_health h
       where h.organization_id = $1 and h.channel_session_id = $2
       for update`,
      [tenantId, channelSessionId, k.cooldownMs, HEALTH_HOLD_REF_KIND],
    );
    const row = rows[0];
    if (row === undefined) {
      // sessão sumiu entre o list e o lock — nada a fazer
      await client.query('rollback');
      return delta;
    }

    const blockUnhealthy =
      rates.totalSends >= k.blockRateMinSends &&
      rates.totalSends > 0 &&
      rates.blockedSends / rates.totalSends >= k.blockRateThreshold;
    const responseUnhealthy =
      k.responseRateFloor > 0 &&
      rates.sentLeads >= k.responseRateMinSends &&
      rates.respondedLeads / rates.sentLeads < k.responseRateFloor;
    const unhealthy = blockUnhealthy || responseUnhealthy;
    const degradeReason: HoldReason = blockUnhealthy ? 'block_rate' : 'response_rate';

    const engageHold = async (reason: HoldReason): Promise<void> => {
      await client.query(
        `update channel_session_health
         set health_hold_active = true, health_hold_reason = $3, health_held_at = now(), updated_at = now()
         where organization_id = $1 and channel_session_id = $2`,
        [tenantId, channelSessionId, reason],
      );
      delta.held = 1;
      // inbox item 1× por episódio: só cria se não há item aberto do número (dedup).
      const ins = await client.query(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
         select $1, 'other', $2, $3, $4, $5, $6
         where not exists (
           select 1 from agent_inbox_items
           where organization_id = $1 and ref_kind = $5 and ref_id = $6 and status = 'open'
         )`,
        [
          tenantId,
          reason === 'go_live' ? 'info' : 'warn',
          reason === 'go_live'
            ? 'Número novo aguardando liberação (go-live)'
            : 'Saúde do número degradada — outbound em espera automática',
          diagnosisBody(reason, rates, k),
          HEALTH_HOLD_REF_KIND,
          channelSessionId,
        ],
      );
      delta.alerts = ins.rowCount ?? 0;
    };

    const clearHold = async (): Promise<void> => {
      await client.query(
        `update channel_session_health
         set health_hold_active = false, health_hold_reason = null, updated_at = now()
         where organization_id = $1 and channel_session_id = $2`,
        [tenantId, channelSessionId],
      );
      delta.released = 1;
    };

    if (row.health_released_at === null) {
      // Número novo (fail-safe): nasce em hold com razão go_live; libera SÓ por ato
      // explícito (humano resolve o item = liberação inicial de go-live).
      if (!row.health_hold_active) {
        await engageHold('go_live');
      } else if (!row.has_open_item) {
        await client.query(
          `update channel_session_health
           set health_released_at = now(), health_hold_active = false, health_hold_reason = null, updated_at = now()
           where organization_id = $1 and channel_session_id = $2`,
          [tenantId, channelSessionId],
        );
        delta.released = 1;
      }
    } else if (row.health_hold_active) {
      // Já liberado alguma vez → circuito de degradação. Retomada:
      if (!row.has_open_item) {
        // manual: humano resolveu o item.
        await clearHold();
      } else if (row.cooldown_elapsed && !unhealthy) {
        // automática: cool-down decorrido E recuperado → libera e auto-resolve o episódio.
        await clearHold();
        await client.query(
          `update agent_inbox_items set status = 'resolved'
           where organization_id = $1 and ref_kind = $2 and ref_id = $3 and status = 'open'`,
          [tenantId, HEALTH_HOLD_REF_KIND, channelSessionId],
        );
      }
    } else if (unhealthy) {
      await engageHold(degradeReason);
    }

    await client.query('commit');
    return delta;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      throw new AggregateError([err, rollbackErr], 'rollback falhou na avaliação de saúde do número');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Um tick do circuito: para cada número do espelho, computa taxas → decide hold/unhold
 * (sob lock) → enforce dos holds (reason-aware, uma vez no fim). Idempotente; um tick
 * perdido é recuperado no seguinte. Erro numa sessão não derruba as demais.
 * ponytail: laço por sessão (N minúsculo no MVP: 1 número piloto); se um tenant tiver
 * muitos números, o upgrade é uma agregação set-based — não antes de precisar.
 */
export async function channelHealthTick(harness: pg.Pool, log?: Logger): Promise<HealthTickResult> {
  const result: HealthTickResult = {
    evaluated: 0,
    held: 0,
    released: 0,
    alerts: 0,
    jobsHeld: 0,
    jobsReleased: 0,
  };
  const { rows: sessions } = await harness.query<{
    organization_id: string;
    channel_session_id: string;
  }>('select organization_id, channel_session_id from channel_session_health');
  for (const s of sessions) {
    try {
      const k = await loadHealthKnobs(harness, s.organization_id, s.channel_session_id, log);
      const rates = await computeSessionRates(
        harness,
        s.organization_id,
        s.channel_session_id,
        k.windowMs,
      );
      const delta = await evaluateSession(harness, s.organization_id, s.channel_session_id, rates, k);
      result.evaluated += 1;
      result.held += delta.held;
      result.released += delta.released;
      result.alerts += delta.alerts;
    } catch (err) {
      log?.error('health: avaliação de sessão falhou — segue as demais', {
        channel_session_id: s.channel_session_id,
        error: errMsg(err),
      });
    }
  }
  const jobs = await enforceHolds(harness);
  result.jobsHeld = jobs.held;
  result.jobsReleased = jobs.released;
  return result;
}

export interface HealthLoopConfig {
  /** ritmo do ticker — knob NUMBER_HEALTH_INTERVAL_MS */
  intervalMs: number;
}

/**
 * Loop de produção (main.ts) — roda contra o Postgres do harness (não precisa do CRM;
 * só lê o que já foi drenado/medido). Tick falhado loga e espera o próximo.
 */
export async function runHealthLoop(
  harness: pg.Pool,
  cfg: HealthLoopConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const tick = await channelHealthTick(harness, log);
      const activity = tick.held + tick.released + tick.alerts + tick.jobsHeld + tick.jobsReleased;
      if (activity > 0) log.info('health: tick processado', { ...tick });
    } catch (err) {
      log.error('health: tick falhou — tenta no próximo intervalo', { error: errMsg(err) });
    }
    try {
      await sleep(cfg.intervalMs, undefined, { signal });
    } catch {
      break; // abort durante o sleep = shutdown
    }
  }
}
