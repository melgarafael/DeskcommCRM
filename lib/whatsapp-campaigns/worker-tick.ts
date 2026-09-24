/**
 * Um tick do worker: claim → guards → enviar → attempt → pacing.
 * Usa pg Pool (service role connection string) para RPC claim + updates.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import { checkContactEligibility, classifySendError } from "@/lib/whatsapp-campaigns/eligibility";
import {
  isInsideSendWindow,
  nextSendAtIso,
  nextWindowOpen,
} from "@/lib/whatsapp-campaigns/pacing";
import {
  isProviderAccepted,
  sendCampaignMessage,
} from "@/lib/whatsapp-campaigns/send";

export interface ClaimedRecipient {
  recipient_id: string;
  organization_id: string;
  campaign_id: string;
  contact_id: string;
  channel_session_id: string;
  outbound_message_id: string;
  message_rendered: string | null;
  attempt_count: number;
  phone_number_snapshot: string;
}

export async function recoverStaleClaims(
  pool: pg.Pool,
  staleSeconds = 180,
): Promise<number> {
  const { rows } = await pool.query(
    `select public.fn_recover_stale_whatsapp_campaign_claims($1) as n`,
    [staleSeconds],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function claimRecipient(
  pool: pg.Pool,
  workerId: string,
): Promise<ClaimedRecipient | null> {
  const { rows } = await pool.query(
    `select * from public.fn_claim_whatsapp_campaign_recipient($1, $2)`,
    [workerId, 120],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    recipient_id: row.recipient_id,
    organization_id: row.organization_id,
    campaign_id: row.campaign_id,
    contact_id: row.contact_id,
    channel_session_id: row.channel_session_id,
    outbound_message_id: row.outbound_message_id,
    message_rendered: row.message_rendered,
    attempt_count: Number(row.attempt_count),
    phone_number_snapshot: row.phone_number_snapshot,
  };
}

export async function releaseSessionLease(
  pool: pg.Pool,
  channelSessionId: string,
  workerId: string,
): Promise<void> {
  await pool.query(
    `delete from public.whatsapp_campaign_session_leases
      where channel_session_id = $1 and worker_id = $2`,
    [channelSessionId, workerId],
  );
}

/** Releitura imediata antes do HTTP externo (pause/cancel/session). */
export async function assertStillRunnable(
  pool: pg.Pool,
  claimed: ClaimedRecipient,
): Promise<{ ok: true } | { ok: false; reason: "paused" | "cancelled" | "session_down" | "missing" }> {
  const { rows: campRows } = await pool.query(
    `select status from public.whatsapp_campaigns
      where id = $1 and organization_id = $2`,
    [claimed.campaign_id, claimed.organization_id],
  );
  const status = campRows[0]?.status as string | undefined;
  if (!status) return { ok: false, reason: "missing" };
  if (status === "cancelled") return { ok: false, reason: "cancelled" };
  if (status !== "running") return { ok: false, reason: "paused" };

  const { rows: sessRows } = await pool.query(
    `select status from public.channel_sessions
      where id = $1 and organization_id = $2`,
    [claimed.channel_session_id, claimed.organization_id],
  );
  if (!sessRows[0] || sessRows[0].status !== "WORKING") {
    return { ok: false, reason: "session_down" };
  }
  return { ok: true };
}

async function releaseClaimWithoutConsumingAttempt(
  pool: pg.Pool,
  claimed: ClaimedRecipient,
  workerId: string,
  nextStatus: "pending" | "scheduled" | "cancelled",
  nextAttemptAt?: string | null,
): Promise<void> {
  if (nextStatus === "cancelled") {
    await pool.query(
      `update public.whatsapp_campaign_recipients
          set status = 'cancelled', cancelled_at = now(),
              claimed_at = null, claimed_by = null,
              attempt_count = greatest(attempt_count - 1, 0)
        where id = $1 and organization_id = $2 and status = 'processing'`,
      [claimed.recipient_id, claimed.organization_id],
    );
  } else {
    await pool.query(
      `update public.whatsapp_campaign_recipients
          set status = $3,
              next_attempt_at = $4,
              claimed_at = null, claimed_by = null,
              attempt_count = greatest(attempt_count - 1, 0)
        where id = $1 and organization_id = $2 and status = 'processing'`,
      [
        claimed.recipient_id,
        claimed.organization_id,
        nextStatus,
        nextAttemptAt ?? null,
      ],
    );
  }
  await releaseSessionLease(pool, claimed.channel_session_id, workerId);
}

export async function processClaimedRecipient(
  pool: pg.Pool,
  admin: SupabaseClient,
  workerId: string,
  claimed: ClaimedRecipient,
): Promise<"sent" | "failed" | "skipped" | "deferred" | "uncertain"> {
  const { rows: campRows } = await pool.query(
    `select id, organization_id, status, message_text, min_interval_seconds, max_interval_seconds,
            send_window_start::text, send_window_end::text, timezone, daily_limit, channel_session_id
       from public.whatsapp_campaigns
      where id = $1 and organization_id = $2`,
    [claimed.campaign_id, claimed.organization_id],
  );
  const camp = campRows[0];
  if (!camp || camp.status !== "running") {
    if (camp?.status === "cancelled") {
      await releaseClaimWithoutConsumingAttempt(pool, claimed, workerId, "cancelled");
    } else {
      await releaseClaimWithoutConsumingAttempt(pool, claimed, workerId, "pending");
    }
    return "deferred";
  }

  const now = new Date();
  if (
    !isInsideSendWindow(
      now,
      camp.send_window_start,
      camp.send_window_end,
      camp.timezone || "America/Sao_Paulo",
    )
  ) {
    const next =
      nextWindowOpen(
        now,
        camp.send_window_start,
        camp.send_window_end,
        camp.timezone || "America/Sao_Paulo",
      ) ?? new Date(now.getTime() + 3600_000);
    await releaseClaimWithoutConsumingAttempt(
      pool,
      claimed,
      workerId,
      "scheduled",
      next.toISOString(),
    );
    await pool.query(
      `update public.whatsapp_campaigns set next_send_at = $3 where id = $1 and organization_id = $2`,
      [claimed.campaign_id, claimed.organization_id, next.toISOString()],
    );
    return "deferred";
  }

  const { rows: sessRows } = await pool.query(
    `select status, daily_message_limit from public.channel_sessions
      where id = $1 and organization_id = $2`,
    [claimed.channel_session_id, claimed.organization_id],
  );
  const sess = sessRows[0];
  if (!sess || sess.status !== "WORKING") {
    await pool.query(
      `update public.whatsapp_campaign_sessions
          set next_send_at = now() + interval '5 minutes'
        where campaign_id = $1
          and organization_id = $2
          and channel_session_id = $3`,
      [claimed.campaign_id, claimed.organization_id, claimed.channel_session_id],
    );
    await pool.query(
      `update public.whatsapp_campaigns
          set session_problem = 'awaiting_whatsapp_session',
              next_send_at = now() + interval '30 seconds'
        where id = $1 and organization_id = $2`,
      [claimed.campaign_id, claimed.organization_id],
    );
    await releaseClaimWithoutConsumingAttempt(
      pool,
      claimed,
      workerId,
      "pending",
      new Date(Date.now() + 5_000).toISOString(),
    );
    return "deferred";
  }

  if (camp.daily_limit || sess.daily_message_limit) {
    const { rows: cntRows } = await pool.query(
      `select count(*)::int as n from public.whatsapp_campaign_recipients
        where campaign_id = $1 and organization_id = $2
          and status in ('sent','delivered','read','replied')
          and sent_at >= date_trunc('day', now() at time zone $3)`,
      [claimed.campaign_id, claimed.organization_id, camp.timezone || "America/Sao_Paulo"],
    );
    const sentToday = cntRows[0]?.n ?? 0;
    const limits = [camp.daily_limit, sess.daily_message_limit].filter(
      (x): x is number => typeof x === "number" && x > 0,
    );
    const cap = limits.length ? Math.min(...limits) : null;
    if (cap !== null && sentToday >= cap) {
      const tomorrow = new Date(now.getTime() + 86400_000);
      await releaseClaimWithoutConsumingAttempt(
        pool,
        claimed,
        workerId,
        "scheduled",
        tomorrow.toISOString(),
      );
      await pool.query(
        `update public.whatsapp_campaigns set next_send_at = $3 where id = $1 and organization_id = $2`,
        [claimed.campaign_id, claimed.organization_id, tomorrow.toISOString()],
      );
      return "deferred";
    }
  }

  const elig = await checkContactEligibility(
    admin,
    claimed.organization_id,
    claimed.contact_id,
  );
  if (!elig.ok) {
    await pool.query(
      `insert into public.whatsapp_campaign_attempts
        (organization_id, campaign_id, recipient_id, attempt_number, channel_session_id, status, finished_at, error_code, error_message)
       values ($1,$2,$3,$4,$5,'skipped',now(),$6,$6)`,
      [
        claimed.organization_id,
        claimed.campaign_id,
        claimed.recipient_id,
        claimed.attempt_count,
        claimed.channel_session_id,
        elig.reason,
      ],
    );
    await pool.query(
      `update public.whatsapp_campaign_recipients
          set status = 'skipped', skipped_reason = $3, claimed_at = null, claimed_by = null
        where id = $1 and organization_id = $2`,
      [claimed.recipient_id, claimed.organization_id, elig.reason],
    );
    await afterSendPacing(pool, camp, claimed, workerId);
    await maybeCompleteCampaign(pool, claimed);
    return "skipped";
  }

  // Gate final imediatamente antes do HTTP externo
  const gate = await assertStillRunnable(pool, claimed);
  if (!gate.ok) {
    if (gate.reason === "cancelled") {
      await releaseClaimWithoutConsumingAttempt(pool, claimed, workerId, "cancelled");
    } else if (gate.reason === "session_down") {
      // Não falha a campanha: libera recipient e deixa claim pegar outra sessão.
      await pool.query(
        `update public.whatsapp_campaign_sessions
            set next_send_at = now() + interval '5 minutes'
          where campaign_id = $1
            and organization_id = $2
            and channel_session_id = $3`,
        [claimed.campaign_id, claimed.organization_id, claimed.channel_session_id],
      );
      await pool.query(
        `update public.whatsapp_campaigns
            set session_problem = 'awaiting_whatsapp_session',
                next_send_at = now() + interval '30 seconds'
          where id = $1 and organization_id = $2`,
        [claimed.campaign_id, claimed.organization_id],
      );
      await releaseClaimWithoutConsumingAttempt(
        pool,
        claimed,
        workerId,
        "pending",
        new Date(Date.now() + 5_000).toISOString(),
      );
    } else {
      await releaseClaimWithoutConsumingAttempt(pool, claimed, workerId, "pending");
    }
    return "deferred";
  }

  const body = claimed.message_rendered || camp.message_text;

  await pool.query(
    `insert into public.whatsapp_campaign_attempts
      (organization_id, campaign_id, recipient_id, attempt_number, channel_session_id, status)
     values ($1,$2,$3,$4,$5,'started')
     on conflict (recipient_id, attempt_number) do nothing`,
    [
      claimed.organization_id,
      claimed.campaign_id,
      claimed.recipient_id,
      claimed.attempt_count,
      claimed.channel_session_id,
    ],
  );

  try {
    const msg = await sendCampaignMessage({
      admin,
      organizationId: claimed.organization_id,
      contactId: claimed.contact_id,
      channelSessionId: claimed.channel_session_id,
      body,
      outboundMessageId: claimed.outbound_message_id,
      campaignId: claimed.campaign_id,
      recipientId: claimed.recipient_id,
    });

    if (isProviderAccepted(msg) || msg.status === "queued") {
      // queued sem external_id: adapter NOOP / sessão — não é sent confirmado.
      // Só marca sent se provider aceitou OU se já reconciliamos com external_id.
      if (isProviderAccepted(msg)) {
        await pool.query(
          `update public.whatsapp_campaign_attempts
              set status = 'sent', finished_at = now(), message_id = $3, external_message_id = $4
            where recipient_id = $1 and attempt_number = $2`,
          [claimed.recipient_id, claimed.attempt_count, msg.id, msg.external_id],
        );
        await pool.query(
          `update public.whatsapp_campaign_recipients
              set status = 'sent', sent_at = coalesce(sent_at, now()), message_id = $3,
                  external_message_id = $4, claimed_at = null, claimed_by = null, last_error = null
            where id = $1 and organization_id = $2`,
          [claimed.recipient_id, claimed.organization_id, msg.id, msg.external_id],
        );
        await afterSendPacing(pool, camp, claimed, workerId);
        await maybeCompleteCampaign(pool, claimed);
        return "sent";
      }
      // queued: não confirma — libera claim sem sent (evita "enviado" falso)
      throw new Error("provider_uncertain:message_still_queued");
    }

    if (msg.status === "failed") {
      throw new Error(msg.error_message || msg.error_code || "send_failed");
    }

    throw new Error(`provider_uncertain:unexpected_status=${msg.status}`);
  } catch (err) {
    const classified = classifySendError(err);
    await pool.query(
      `update public.whatsapp_campaign_attempts
          set status = 'failed', finished_at = now(), error_code = $3, error_message = $4
        where recipient_id = $1 and attempt_number = $2`,
      [claimed.recipient_id, claimed.attempt_count, classified.code, classified.message],
    );

    if (classified.uncertain) {
      await pool.query(
        `update public.whatsapp_campaign_recipients
            set status = 'send_uncertain',
                message_id = coalesce(message_id, $3),
                last_error = $4,
                claimed_at = null, claimed_by = null
          where id = $1 and organization_id = $2`,
        [
          claimed.recipient_id,
          claimed.organization_id,
          claimed.outbound_message_id,
          classified.message,
        ],
      );
      await afterSendPacing(pool, camp, claimed, workerId);
      await maybeCompleteCampaign(pool, claimed);
      return "uncertain";
    }

    if (classified.permanent || claimed.attempt_count >= 3) {
      await pool.query(
        `update public.whatsapp_campaign_recipients
            set status = 'failed', failed_at = now(), last_error = $3,
                claimed_at = null, claimed_by = null
          where id = $1 and organization_id = $2`,
        [claimed.recipient_id, claimed.organization_id, classified.message],
      );
    } else {
      const retryAt = new Date(Date.now() + Math.min(300_000, claimed.attempt_count * 60_000));
      await pool.query(
        `update public.whatsapp_campaign_recipients
            set status = 'failed', next_attempt_at = $3, last_error = $4,
                claimed_at = null, claimed_by = null
          where id = $1 and organization_id = $2`,
        [
          claimed.recipient_id,
          claimed.organization_id,
          retryAt.toISOString(),
          classified.message,
        ],
      );
    }
    await afterSendPacing(pool, camp, claimed, workerId);
    await maybeCompleteCampaign(pool, claimed);
    return "failed";
  }
}

async function afterSendPacing(
  pool: pg.Pool,
  camp: {
    id: string;
    organization_id: string;
    min_interval_seconds: number;
    max_interval_seconds: number;
  },
  claimed: ClaimedRecipient,
  workerId: string,
): Promise<void> {
  const next = nextSendAtIso(camp.min_interval_seconds, camp.max_interval_seconds);
  // Pacing por sessão (independente) + eco na campanha (min das sessões / usado)
  await pool.query(
    `update public.whatsapp_campaign_sessions
        set next_send_at = $3
      where campaign_id = $1
        and organization_id = $2
        and channel_session_id = $4`,
    [camp.id, camp.organization_id, next, claimed.channel_session_id],
  );
  await pool.query(
    `update public.whatsapp_campaigns
        set next_send_at = least(
              coalesce(next_send_at, $3::timestamptz),
              $3::timestamptz
            ),
            session_problem = null
      where id = $1 and organization_id = $2`,
    [camp.id, camp.organization_id, next],
  );
  await releaseSessionLease(pool, claimed.channel_session_id, workerId);
}

/**
 * Conclusão eficiente: EXISTS de recipient ainda aberto.
 * Abertos: pending/scheduled/processing/failed-retryable/send_uncertain.
 */
export async function maybeCompleteCampaign(
  pool: pg.Pool,
  claimed: ClaimedRecipient,
): Promise<void> {
  const { rows } = await pool.query(
    `select exists (
        select 1 from public.whatsapp_campaign_recipients
         where campaign_id = $1 and organization_id = $2
           and (
             status in ('pending','scheduled','processing','send_uncertain')
             or (status = 'failed' and attempt_count < max_attempts)
           )
      ) as has_open`,
    [claimed.campaign_id, claimed.organization_id],
  );
  if (!rows[0]?.has_open) {
    await pool.query(
      `update public.whatsapp_campaigns
          set status = 'completed', completed_at = now()
        where id = $1 and organization_id = $2 and status = 'running'`,
      [claimed.campaign_id, claimed.organization_id],
    );
  }
}

/** Propaga ACK de messages → recipients.
 * send_uncertain só avança quando há prova (external_id). Não é retry.
 */
export async function syncRecipientStatusesFromMessages(pool: pg.Pool): Promise<number> {
  const { rowCount } = await pool.query(`
    update public.whatsapp_campaign_recipients r
       set status = case
             when m.status = 'read' then 'read'
             when m.status = 'delivered' then 'delivered'
             when m.status = 'sent' then 'sent'
             else r.status
           end,
           delivered_at = coalesce(r.delivered_at, m.delivered_at),
           read_at = coalesce(r.read_at, m.read_at),
           sent_at = coalesce(r.sent_at, m.sent_at),
           external_message_id = coalesce(r.external_message_id, m.external_id),
           message_id = coalesce(r.message_id, m.id),
           uncertainty_resolution = case
             when r.status = 'send_uncertain'
               then coalesce(r.uncertainty_resolution, 'provider_ack')
             else r.uncertainty_resolution
           end,
           uncertainty_resolved_at = case
             when r.status = 'send_uncertain' and r.uncertainty_resolved_at is null
               then now()
             else r.uncertainty_resolved_at
           end,
           updated_at = now()
      from public.messages m
     where r.message_id = m.id
       and r.organization_id = m.organization_id
       and r.status in ('sent', 'delivered', 'send_uncertain')
       and m.external_id is not null
       and m.status in ('delivered', 'read', 'sent')
       and (
         (m.status = 'sent' and r.status = 'send_uncertain')
         or (m.status = 'delivered' and r.status in ('sent', 'send_uncertain'))
         or (m.status = 'read' and r.status in ('sent', 'delivered', 'send_uncertain'))
       )
  `);
  return rowCount ?? 0;
}
