import type pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { WacallsClient } from "@/lib/wacalls/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolverNumeroDiscavel } from "@/lib/voice/numero-discavel";
import {
  reserveSubscriptionAi,
  recordSubscriptionAiEvidence,
  settleSubscriptionAi,
} from "@/lib/billing/ai-allowance";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { audioBridge, VOICE_MODEL, type RealtimeUsage } from "./audio";
import { voiceCost } from "./cost";
import { missionContext } from "./store";
import { missionPrompt } from "./schema";

type Mission = {
  id: string;
  organization_id: string;
  conversation_id: string;
  created_by: string;
  agent_id: string;
  channel_id: string;
  test: boolean;
  test_contact_id: string | null;
  objective: string;
  call_id: string | null;
  session_id: string | null;
};
const pause = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }).catch(() => {});

export async function runVoiceMissionLoop(pool: pg.Pool, log: Logger, signal: AbortSignal) {
  const apiKey = process.env.OPENAI_API_KEY,
    base = process.env.WACALLS_API_BASE_URL,
    token = process.env.WACALLS_API_TOKEN;
  if (!apiKey || !base || !token) return;
  const wa = new WacallsClient(base, token);
  let beatBusy = false;
  const beat = async () => {
    if (beatBusy) return;
    beatBusy = true;
    try {
      await pool.query(
        "insert into voice_mission_runtime(id,heartbeat_at) values(1,now()) on conflict(id) do update set heartbeat_at=now()",
      );
    } catch {
      log.warn("voice mission heartbeat unavailable", {});
    } finally {
      beatBusy = false;
    }
  };
  await beat();
  const heartbeat = setInterval(() => void beat(), 5000);
  try {
    while (!signal.aborted) {
      try {
        await pool.query(
          `update voice_missions set status='failed',ended_at=now(),error='O pedido ficou aguardando por muito tempo. Revise e faça um novo pedido para ligar.',updated_at=now() where status='queued' and updated_at<now()-interval '2 minutes'`,
        );
        // A process loss never resubmits a dial. Reconcile and terminate the known call.
        const stale = await pool.query<Mission>(
          `select * from voice_missions where status in ('preparing','dialing','ringing','connected','finishing') and heartbeat_at<now()-interval '90 seconds' limit 10`,
        );
        for (const m of stale.rows) {
          if (m.call_id && m.session_id) await wa.endCall(m.session_id, m.call_id);
          await pool.query(
            `update voice_missions set status='uncertain',ended_at=now(),error='O serviço foi interrompido. Confira o resultado antes de fazer outro pedido.',updated_at=now() where id=$1 and organization_id=$2 and heartbeat_at<now()-interval '90 seconds'`,
            [m.id, m.organization_id],
          );
        }
        const claimed = await pool.query<Mission>(
          `update voice_missions set status='preparing',heartbeat_at=now(),started_at=now(),updated_at=now() where id=(select id from voice_missions where status='queued' and not cancel_requested order by created_at for update skip locked limit 1) returning *`,
        );
        if (claimed.rows[0]) await executeMission(pool, wa, apiKey, claimed.rows[0], log, signal);
        else await pause(2000, signal);
      } catch {
        log.error("voice mission loop failed; queued requests retained", {});
        await pause(3000, signal);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function executeMission(
  pool: pg.Pool,
  wa: WacallsClient,
  apiKey: string,
  m: Mission,
  log: Logger,
  outer: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer.addEventListener("abort", abort, { once: true });
  const signal = controller.signal;
  let callId: string | null = null,
    sessionId: string | null = null,
    reservation: string | null = null;
  let connected = false,
    cancelled = false,
    ended = false,
    redacted = false,
    dialAttempted = false,
    providerStarted = false,
    monitorBusy = false;
  let failure = false,
    hangupFailed = false;
  let audio: Awaited<ReturnType<typeof audioBridge>> | null = null;
  const usage: RealtimeUsage[] = [];
  const update = async (sql: string, params: unknown[] = []) =>
    pool.query(
      `update voice_missions set ${sql},updated_at=now() where id=$1 and organization_id=$2`,
      [m.id, m.organization_id, ...params],
    );
  const monitor = async () => {
    if (monitorBusy) return;
    monitorBusy = true;
    try {
      const r = await pool.query(
        `update voice_missions set heartbeat_at=now() where id=$1 and organization_id=$2 returning cancel_requested,transport_status,transport_ended,redacted,call_id`,
        [m.id, m.organization_id],
      );
      const state = r.rows[0];
      if (!state) throw new Error("mission_missing");
      callId = callId ?? state.call_id;
      redacted = state.redacted;
      cancelled = state.cancel_requested;
      ended = state.transport_ended;
      if (state.transport_status === "connected") connected = true;
      const permission = await pool.query(
        `select 1 from conversations c join contacts p on p.id=c.contact_id and p.organization_id=c.organization_id join org_voice_calls o on o.organization_id=c.organization_id and o.enabled join user_organizations u on u.organization_id=c.organization_id and u.user_id=$3 and u.role in ('agent','manager','admin') and u.accepted_at is not null where c.id=$1 and c.organization_id=$2 and not p.is_blocked and not p.is_anonymized and c.status not in ('closed','resolved','archived') and (not $4 or exists(select 1 from contacts t where t.id=$5 and t.organization_id=c.organization_id and not t.is_blocked and not t.is_anonymized))`,
        [m.conversation_id, m.organization_id, m.created_by, m.test, m.test_contact_id],
      );
      if (!permission.rowCount) cancelled = true;
      if (cancelled || ended || redacted) controller.abort();
    } catch {
      failure = true;
      controller.abort();
    } finally {
      monitorBusy = false;
    }
  };
  const timer = setInterval(() => void monitor(), 1000);
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  const limit = setTimeout(() => controller.abort(), 360000);
  try {
    const context = await missionContext(pool, m.organization_id, m.conversation_id);
    const { rows } = await pool.query(
      `select v.system_prompt,s.wacalls_session_id,p.phone_number from ai_agents a
      join ai_agent_versions v on v.id=a.published_version_id and v.organization_id=a.organization_id
      join channel_sessions s on s.id=$3 and s.organization_id=a.organization_id and s.provider='wacalls' and s.status='WORKING' and s.archived_at is null
      join conversations c on c.id=$4 and c.organization_id=a.organization_id
      join contacts p on p.id=case when $5 then $6::uuid else c.contact_id end and p.organization_id=a.organization_id
      join org_voice_calls o on o.organization_id=a.organization_id and o.enabled
      where a.id=$2 and a.organization_id=$1 and a.is_active and a.archived_at is null and not p.is_blocked and not p.is_anonymized`,
      [m.organization_id, m.agent_id, m.channel_id, m.conversation_id, m.test, m.test_contact_id],
    );
    const config = rows[0];
    if (!config?.phone_number || !config.wacalls_session_id) throw new Error("mission_not_ready");
    sessionId = config.wacalls_session_id;
    const sessions = await wa.listSessions();
    if (!sessions.some((s) => s.id === sessionId && s.paired)) throw new Error("number_not_paired");
    const target = await resolverNumeroDiscavel(
      createAdminClient(),
      m.organization_id,
      config.phone_number,
    );
    if (!/^\d{8,15}$/.test(target.digitos)) throw new Error("invalid_phone");
    reservation = await reserveSubscriptionAi(pool, m.organization_id);
    await recordSubscriptionAiEvidence(
      pool,
      m.organization_id,
      reservation,
      { provider: "openai", model: VOICE_MODEL },
      null,
    );
    await update(
      "context_snapshot=case when redacted then null else $3 end,session_id=$4,reservation_id=$5",
      [context, sessionId, reservation],
    );
    await monitor();
    if (signal.aborted) throw new Error("mission_cancelled");
    audio = await audioBridge({
      apiKey,
      instructions: missionPrompt(m.objective, context, config.system_prompt),
      signal,
      onConversation: async (id) => {
        providerStarted = true;
        await update("provider_conversation_id=$3", [id]);
      },
      onUsage: (u) => {
        usage.push(u);
      },
      exchange: async (sdp) => {
        await monitor();
        if (signal.aborted) throw new Error("mission_cancelled");
        await update("status='dialing'");
        dialAttempted = true;
        const call = await wa.startCall(sessionId!, `ai:${m.id}`, target.digitos);
        callId = call.callId;
        await update(
          "call_id=$3,status=case when transport_status='connected' then 'connected' else 'ringing' end",
          [callId],
        );
        if (signal.aborted) throw new Error("mission_cancelled");
        return (await wa.exchangeWebrtc(sessionId!, callId, sdp)).sdpAnswer;
      },
      onReady: async () => {
        const deadline = Date.now() + 45000;
        while (!signal.aborted && !connected && Date.now() < deadline) {
          await monitor();
          await pause(300, signal);
        }
        if (!connected || signal.aborted) throw new Error("call_not_answered");
        await update("status='connected'");
        if (!m.test)
          await pool.query(
            `update conversations set bot_silenced_until=now()+interval '6 minutes',last_handoff_reason=$3,updated_at=now() where id=$1 and organization_id=$2 and (bot_silenced_until is null or bot_silenced_until<now())`,
            [m.conversation_id, m.organization_id, `voice-mission:${m.id}`],
          );
        clearTimeout(limit);
        durationTimer = setTimeout(() => controller.abort(), 300000);
      },
    });
    if (audio.error) throw new Error(audio.error);
  } catch {
    failure = true;
    log.warn("voice mission interrupted", { mission_id: m.id, organization_id: m.organization_id });
  } finally {
    clearInterval(timer);
    clearTimeout(limit);
    clearTimeout(durationTimer);
    outer.removeEventListener("abort", abort);
    controller.abort();
    // If the POST response was lost, the SSE owner still identifies the same call.
    try {
      await monitor();
      if (callId && sessionId && !ended) await wa.endCall(sessionId, callId);
    } catch {
      hangupFailed = true;
    }
    const status =
      hangupFailed || outer.aborted
        ? "uncertain"
        : cancelled
          ? "cancelled"
          : !connected && dialAttempted && !callId
            ? "uncertain"
            : !connected && callId
              ? "unanswered"
              : failure
                ? "failed"
                : "completed";
    const result = audio?.result ?? {
      summary: connected
        ? "A ligação terminou sem um resumo confirmado."
        : "A conversa por voz não foi concluída.",
      next_step: "Confira o atendimento antes de solicitar uma nova ligação.",
      outcome: "pending",
    };
    // Transcription may be charged separately; incomplete evidence keeps the reservation pending.
    await recordSubscriptionAiEvidence(
      pool,
      m.organization_id,
      reservation,
      { provider: "openai", model: VOICE_MODEL },
      {
        version: 1,
        steps: usage.map((u) => ({
          responseId: u.id,
          inputTokens: typeof u.usage.input_tokens === "number" ? u.usage.input_tokens : null,
          outputTokens: typeof u.usage.output_tokens === "number" ? u.usage.output_tokens : null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          serviceTier: null,
        })),
      },
    ).catch(() => {
      failure = true;
    });
    await settleSubscriptionAi(
      pool,
      m.organization_id,
      reservation,
      providerStarted ? (!failure && audio?.result ? voiceCost(usage) : null) : 0,
    ).catch(() => {
      failure = true;
    });
    await update(
      "status=$3,ended_at=now(),result=case when redacted then null else $4::jsonb end,usage_evidence=case when redacted then null else $5::jsonb end,error=$6",
      [
        status,
        JSON.stringify({ ...result, transcript: audio?.transcript ?? [] }),
        JSON.stringify(usage),
        status === "failed"
          ? "A ligação não pôde ser concluída. Confira a conexão e tente com um novo pedido."
          : status === "uncertain"
            ? "Confira o resultado e o número antes de tentar novamente."
            : null,
      ],
    );
    await pool.query(
      `update conversations set bot_silenced_until=null,last_handoff_reason=null,updated_at=now() where id=$1 and organization_id=$2 and last_handoff_reason=$3`,
      [m.conversation_id, m.organization_id, `voice-mission:${m.id}`],
    );
    if (!redacted)
      await pool.query(
        `insert into conversation_notes(id,organization_id,conversation_id,created_by_user_id,body) select $1,$2,$3,$4,$5 where not exists(select 1 from voice_missions where id=$1 and redacted) on conflict(id) do nothing`,
        [
          m.id,
          m.organization_id,
          m.conversation_id,
          m.created_by,
          `Ligação por IA: ${status}.\n${result.summary}\nPróximo passo: ${result.next_step}`,
        ],
      );
  }
}
