import type pg from "pg";
import { reconcileAcceptedSend } from "../edge/crm/send-ledger";
import type { JobRow } from "../queue/queue";
import { claimOfJob } from "../queue/claim";
import type { CrmEdgeConfig } from "../edge/crm/mcp-client";
import { createRuntimeSendChannel, type RuntimeSendChannel } from "@/lib/channels/runtime";
import type { Logger } from "../obs/logger";
import { runBeforeSend } from "../guardrails/before-send";
import { deriveLgpdFromContact, type LgpdContactFields } from "../guardrails/lgpd/legal-basis";
import { withServiceJob } from "@/lib/atendimento/fronteira-server";
import { parseServiceBoundary, StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import {
  assertMeetingDeliveryPg,
  assertMeetingDeliveryReceiptPg,
  MeetingDeliveryBlockedError,
} from "@/lib/agenda/meet-delivery";
import { meetVideoUrl } from "@/lib/agenda/google/meet";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export function createMeetDeliveryHandler(deps: {
  crmCfg: CrmEdgeConfig;
  log: Logger;
  channel?: (pool: pg.Pool) => RuntimeSendChannel;
  sleep?: (ms: number) => Promise<void>;
}) {
  return async (job: JobRow, pool: pg.Pool) => {
    const claim = claimOfJob(job);
    if (!claim || !job.contact_id || job.kind !== "transactional_delivery")
      throw new StaleServiceBoundaryError();
    const context = { organizationId: job.organization_id, jobId: job.id, jobClaim: claim };
    const settle = async (state: string, retryAt?: Date) => {
      await pool.query("select fn_meet_delivery_settle($1,$2,$3,$4,$5,$6)", [
        job.organization_id,
        job.id,
        claim.worker_id,
        claim.acquired_at,
        state,
        retryAt?.toISOString() ?? null,
      ]);
    };
    try {
      await withServiceJob(pool, job, async () => {
        await assertMeetingDeliveryReceiptPg(pool, context);
        if (
          await reconcileAcceptedSend(pool, {
            tenantId: job.organization_id,
            jobId: job.id,
            seq: 1,
          })
        ) {
          await settle("sent");
          return;
        }
        await assertMeetingDeliveryPg(pool, context);
        const boundary = parseServiceBoundary(job.payload.service_boundary)!;
        const { rows } = await pool.query<
          LgpdContactFields & {
            meeting_url: string;
            starts_at: string;
            time_zone: string;
            channel_session_id: string;
            daily_message_limit: number | null;
            archived_at: string | null;
            contact_locale: string | null;
            organization_locale: string;
          }
        >(
          `select a.meeting_url,a.starts_at,a.time_zone,c.source,c.consent,c.is_anonymized,c.locale as contact_locale,o.locale as organization_locale,v.channel_session_id,s.daily_message_limit,to_jsonb(s)->>'archived_at' as archived_at
           from calendar_appointments a join contacts c on c.organization_id=a.organization_id and c.id=a.contact_id
           join organizations o on o.id=a.organization_id
           join conversations v on v.organization_id=a.organization_id and v.contact_id=c.id and v.id=$3
           join channel_sessions s on s.organization_id=v.organization_id and s.id=v.channel_session_id
           where a.organization_id=$1 and a.id=$2 and a.contact_id=$4`,
          [
            job.organization_id,
            job.payload.appointment_id,
            boundary.conversation_id,
            job.contact_id,
          ],
        );
        const row = rows[0];
        const url = meetVideoUrl(row?.meeting_url);
        if (!row || !url || row.archived_at) {
          await settle("blocked:channel");
          return;
        }
        const channel =
          deps.channel?.(pool) ??
          createRuntimeSendChannel(pool, {
            ...deps.crmCfg,
            agentActorId: "agent-engine:meet-delivery",
          });
        const result = await runBeforeSend({
          pool,
          log: deps.log,
          tenantId: job.organization_id,
          leadId: job.contact_id!,
          jobId: job.id,
          meetingDelivery: context,
          channelSessionId: row.channel_session_id,
          crmDailyLimit: row.daily_message_limit,
          body: meetingDeliveryBody(
            row.starts_at,
            row.time_zone,
            url,
            normalizarIdioma(row.contact_locale ?? row.organization_locale),
          ),
          optedOutThisTurn: false,
          now: new Date(),
          lgpd: deriveLgpdFromContact(row, false),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          send: async (body) => {
            await assertMeetingDeliveryPg(pool, context);
            return channel.send({
              tenantId: job.organization_id,
              leadId: job.contact_id,
              jobId: job.id,
              jobClaim: claim,
              seq: 1,
              conversationId: boundary.conversation_id,
              body,
            });
          },
        });
        if (result.status === "vetoed") {
          const reason =
            result.code === "contato_bloqueado"
              ? "opt_out"
              : result.code.startsWith("lgpd_")
                ? "lgpd"
                : result.code === "messaging_window_closed"
                  ? "limits"
                  : "guardrail";
          await settle(result.nextAllowedAt ? "queued" : `blocked:${reason}`, result.nextAllowedAt);
          return;
        }
        switch (result.outcome.kind) {
          case "sent":
          case "already_sent":
            await settle("sent");
            break;
          case "queued":
            await settle("queued");
            break;
          case "blocked":
            await assertMeetingDeliveryPg(pool, context);
            await settle("blocked:opt_out");
            break;
          default:
            await assertMeetingDeliveryPg(pool, context);
            await settle("retry");
        }
      });
    } catch (error) {
      await settle(
        error instanceof MeetingDeliveryBlockedError
          ? `blocked:${error.reason}`
          : error instanceof StaleServiceBoundaryError
            ? "stale"
            : "retry",
      );
    }
  };
}

export function meetingDeliveryBody(
  startsAt: string,
  timeZone: string,
  url: string,
  idioma: Idioma,
): string {
  const when = new Intl.DateTimeFormat(tagDeIdioma(idioma), {
    dateStyle: "short",
    timeStyle: "short",
    timeZone,
  }).format(new Date(startsAt));
  return `${traduzir("Sua reunião está marcada para", idioma)} ${when} (${timeZone}). ${traduzir("Link do Google Meet:", idioma)} ${url}`;
}
