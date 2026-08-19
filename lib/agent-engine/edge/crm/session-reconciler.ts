/**
 * Watchdog de sessão (Fase 4A-2) — o pedaço do Vendaval que ficou de fora do
 * porte e cuja falta causou o incidente real das mensagens presas: o webhook
 * session.status se perde num restart e o espelho `channel_sessions` diverge do
 * WAHA real; como o envio exige WORKING no espelho, respostas ficam `queued`
 * para sempre.
 *
 * Dois deveres, um tick:
 *   1. RECONCILIADOR: lê o status REAL das sessões na API do WAHA e corrige o
 *      espelho quando divergir (a fonte da verdade do status é o WAHA);
 *   2. REDRIVE: mensagens `sent_via='ai'` presas em `queued` cuja sessão está
 *      WORKING são reenviadas pelo WAHA (com espaçamento anti-rajada) e marcadas
 *      `sent` — nunca dropadas, nunca duplicadas (só linhas ainda `queued`).
 *
 * Regra dura nº 4 respeitada: message-plane nunca fala com o WAHA — este módulo
 * é o WATCHDOG (admin-plane), o único lugar do engine autorizado a falar com o
 * WAHA diretamente (o envio normal segue via sendMessageHandler).
 */
import type pg from 'pg';

import { parseWahaMessageId } from '@/lib/waha/message-id';

import type { Logger } from '../../obs/logger';

export interface WatchdogConfig {
  wahaBaseUrl: string;
  wahaApiKey: string;
  /** intervalo do tick (knob WATCHDOG_INTERVAL_MS) */
  intervalMs: number;
  /** idade mínima de uma queued para redrive — evita corrida com o insert do handler */
  redriveMinAgeMs: number;
  /** teto de redrives por tick (anti-rajada) */
  redriveBatchSize: number;
  /** espaçamento entre redrives (base + jitter) */
  redriveSpacingMs: number;
}

interface WahaSession {
  name: string;
  status: string;
}

async function fetchWahaSessions(cfg: WatchdogConfig): Promise<WahaSession[] | null> {
  try {
    const res = await fetch(`${cfg.wahaBaseUrl}/api/sessions?all=true`, {
      headers: { 'X-Api-Key': cfg.wahaApiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as WahaSession[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null; // WAHA fora: tick pula (transiente) — nunca derruba o worker
  }
}

/** Corrige o espelho channel_sessions para o status REAL do WAHA. */
export async function reconcileSessions(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
): Promise<number> {
  const sessions = await fetchWahaSessions(cfg);
  if (sessions === null) {
    log.warn('watchdog: WAHA indisponível — tick de reconciliação pulado', {});
    return 0;
  }
  let fixed = 0;
  for (const s of sessions) {
    const { rows } = await pool.query<{ id: string; status: string }>(
      `update channel_sessions
       set status = $2, updated_at = now()
       where waha_session_name = $1 and status is distinct from $2
       returning id, status`,
      [s.name, s.status],
    );
    for (const row of rows) {
      fixed += 1;
      log.warn('watchdog: espelho de sessão reconciliado com o WAHA real', {
        channel_session_id: row.id,
        waha_session: s.name,
        status: s.status,
      });
    }
  }
  return fixed;
}

interface QueuedRow {
  id: string;
  organization_id: string;
  body: string | null;
  waha_session_name: string;
  wa_identity: string | null;
  wa_lid: string | null;
  phone_number: string | null;
  is_group: boolean;
  group_chat_id: string | null;
}

/**
 * chatId do WAHA a partir da identidade do contato — MESMA REGRA de
 * `resolveWahaChatId` (lib/waha/send.ts), e as duas precisam continuar iguais:
 * este caminho reenvia o que aquele deixou preso, e divergir aqui faria o
 * redrive mandar a mensagem para um endereço diferente do envio original.
 *
 * `wa_lid` na frente pelo motivo da 0122: `wa_identity` é GERADA com o telefone
 * antes do lid, então o contato @lid que ganhou número passa a bater na linha do
 * `phone:` e a conversa mudaria de canal no reenvio.
 */
function chatIdOf(m: QueuedRow): string | null {
  if (m.is_group && m.group_chat_id) return m.group_chat_id;
  if (m.wa_lid) return `${m.wa_lid}@lid`;
  if (m.wa_identity?.startsWith('lid:')) return `${m.wa_identity.slice(4)}@lid`;
  if (m.wa_identity?.startsWith('phone:+')) return `${m.wa_identity.slice(7)}@c.us`;
  if (m.phone_number) return `${m.phone_number.replace('+', '')}@c.us`;
  return null;
}

/** Reenvia mensagens AI presas em queued com sessão WORKING. */
export async function redriveQueued(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
): Promise<number> {
  const { rows } = await pool.query<QueuedRow>(
    `select m.id, m.organization_id, m.body, s.waha_session_name,
            c.wa_identity, c.wa_lid, c.phone_number, v.is_group, v.group_chat_id
     from messages m
     join channel_sessions s on s.id = m.channel_session_id
     join conversations v on v.id = m.conversation_id
     join contacts c on c.id = m.contact_id
     where m.sent_via = 'ai' and m.status = 'queued'
       and s.status = 'WORKING'
       and c.is_blocked = false
       -- ─── Só as sessões que ESTE resgate consegue alcançar ───────────────
       --
       -- Este worker fala um transporte só, direto, e não resolve adapter: ele
       -- e processo separado, com pg cru, sem o seam. Sem este filtro a
       -- consulta trazia mensagem de QUALQUER canal e postava com
       -- session nula — a coluna e nula fora deste transporte. Na melhor
       -- hipótese o provedor recusa e a mensagem fica presa para sempre com um
       -- warn por tique; na pior, um envio sai pelo número errado.
       --
       -- Deixar de fora NÃO é resolver: é parar de fazer a coisa errada. Quem
       -- conta as que ficaram sem resgate é o bloco logo abaixo — silêncio aqui
       -- é o que fez este defeito durar.
       and s.waha_session_name is not null
     order by m.created_at
     limit $1`,
    [cfg.redriveBatchSize],
  );

  // As que este resgate NÃO alcança. Não são reenviadas daqui — enviar em dobro
  // é pior que não enviar, e este processo não tem como saber se o outro
  // caminho já mandou. O que elas não podem continuar sendo é INVISÍVEIS.
  const { rows: foraDoAlcance } = await pool.query<{ n: string }>(
    `select count(*)::text as n
     from messages m
     join channel_sessions s on s.id = m.channel_session_id
     where m.sent_via = 'ai' and m.status = 'queued'
       and s.status = 'WORKING'
       and s.waha_session_name is null`
  );
  const presas = Number(foraDoAlcance[0]?.n ?? '0');
  if (presas > 0) {
    log.warn('watchdog: mensagens presas em canal que este resgate não alcança', {
      quantidade: presas,
    });
  }

  let sent = 0;
  for (const m of rows) {
    const chatId = chatIdOf(m);
    if (chatId === null || m.body === null) {
      log.warn('watchdog: queued sem destino/corpo — pulada', { message_id: m.id });
      continue;
    }
    try {
      const res = await fetch(`${cfg.wahaBaseUrl}/api/sendText`, {
        method: 'POST',
        headers: { 'X-Api-Key': cfg.wahaApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: m.waha_session_name, chatId, text: m.body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log.warn('watchdog: redrive falhou no WAHA — mantida queued para o próximo tick', {
          message_id: m.id,
          status_code: res.status,
        });
        continue;
      }
      const data = (await res.json().catch(() => null)) as unknown;
      const externalId = parseWahaMessageId(data);
      await pool.query(
        `update messages
         set status = 'sent', ack = 0,
             external_id = coalesce($2, external_id),
             metadata = metadata || '{"redrive":"watchdog"}'::jsonb
         where id = $1 and status = 'queued'`,
        [m.id, externalId],
      );
      sent += 1;
      log.info('watchdog: mensagem presa reenviada', { message_id: m.id, has_external_id: externalId !== null });
    } catch (err) {
      log.warn('watchdog: redrive com erro transiente — mantida queued', {
        message_id: m.id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
    // espaçamento anti-rajada entre reenvios
    await new Promise((r) => setTimeout(r, cfg.redriveSpacingMs + Math.random() * cfg.redriveSpacingMs));
  }
  return sent;
}

/** Loop do watchdog — reconcilia e redrive a cada tick; erro nunca derruba o worker. */
export async function runSessionWatchdogLoop(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const fixed = await reconcileSessions(pool, cfg, log);
      const redriven = await redriveQueued(pool, cfg, log);
      if (fixed + redriven > 0) {
        log.info('watchdog: tick com ação', { reconciled: fixed, redriven });
      }
    } catch (err) {
      log.error('watchdog: tick falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, cfg.intervalMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
