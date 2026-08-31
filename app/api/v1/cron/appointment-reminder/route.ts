/**
 * GET/POST /api/v1/cron/appointment-reminder
 *
 * Lembrete de agendamento por WhatsApp — janela fixa de 24h no MVP (Frente A
 * da Agenda nativa, migration 0165). NÃO é um envio cru: passa pela MESMA
 * cadeia `runBeforeSend` (`lib/agent-engine/guardrails/before-send.ts`) que o
 * resto do agent-engine usa — sem ela, mandaria mensagem pra lead que pediu
 * STOP, ignoraria janela de 24h e anti-ban (doutrina WAHA W-01..12).
 *
 * O ENVIO FÍSICO reusa a mesma peça que `followup-turn.ts` usa para a
 * re-entrada determinística (`runDeterministicReentry`,
 * lib/agent-engine/agent/followup-turn.ts:445-573): `WahaChannelAdapter`
 * (lib/agent-engine/edge/channel/waha-adapter.ts) sobre o MESMO `pg.Pool` que
 * `runBeforeSend` recebe — não um novo caminho de rede pro WAHA. O `pool` em
 * si vem de `getRequestPool()` (lib/agent-engine/db/request-pool.ts), o
 * singleton lazy que as rotas `/api/v1` já usam para falar com o engine
 * (ex.: app/api/v1/ai/cases/[id]/reply/route.ts) — diferente do worker
 * (`workers/agent-worker/main.ts`), que cria o pool uma vez no `main()`; uma
 * rota HTTP não tem esse `main()`, então o padrão aqui é o do request-pool.
 *
 * `channel_session_id`/`conversation_id` são os da conversa mais recente do
 * lead — nunca inventados. Sem conversa nenhuma, não há como montar o envio
 * (`ChannelSendInput.conversationId` é obrigatório) — pula o agendamento
 * nesta rodada, a próxima tenta de novo.
 *
 * Marca `reminder_sent_at` só quando o resultado é `sent` — veto não conta
 * como "mandei", pra não mascarar "não pude" como "mandei".
 *
 * `jobId` do envio é o PRÓPRIO id do agendamento (não há job_queue por trás
 * deste cron) e `seq` é sempre 1 — a chave de idempotência do ledger
 * (`send_ledger` unique (job_id, seq), lib/agent-engine/edge/crm/send-message.ts)
 * garante que um crash entre o `send` e o `update reminder_sent_at` não
 * gera um segundo WhatsApp: o replay com o MESMO (appointment_id, 1) dedupa
 * no sink.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import { deriveLgpdFromContact, type LgpdContactFields } from "@/lib/agent-engine/guardrails/lgpd/legal-basis";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { crmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/crm/mcp-client";
import { WahaChannelAdapter } from "@/lib/agent-engine/edge/channel/waha-adapter";

export const dynamic = "force-dynamic";

/** Janela fixa do MVP — não configurável por org ainda (fora de escopo da Frente A). */
export const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const BATCH_LIMIT = 100;

export interface ReminderResult {
  scanned: number;
  sent: number;
  vetoed: number;
  failed: number;
}

interface DueAppointment {
  id: string;
  lead_id: string;
  organization_id: string;
  scheduled_at: string;
}

export async function sendAppointmentReminders(
  admin: ReturnType<typeof createAdminClient>,
  pool: pg.Pool,
  now: Date,
): Promise<ReminderResult> {
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS).toISOString();

  const { data: due, error } = await admin
    .from("appointments")
    .select("id, lead_id, organization_id, scheduled_at")
    .eq("status", "scheduled")
    .is("reminder_sent_at", null)
    .lte("scheduled_at", windowEnd)
    .limit(BATCH_LIMIT);
  if (error) throw new Error(`select_due_failed: ${error.message}`);

  // Mesmo canal físico do caminho determinístico do followup-turn — nunca um
  // send novo inventado para este cron (ver cabeçalho).
  const crmCfg = crmEdgeConfigFromEnv({
    SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const channel = new WahaChannelAdapter(pool, crmCfg);

  const result: ReminderResult = { scanned: 0, sent: 0, vetoed: 0, failed: 0 };
  for (const appt of (due ?? []) as DueAppointment[]) {
    result.scanned += 1;
    try {
      await sendOneReminder(admin, pool, channel, appt, now, result);
    } catch (err) {
      result.failed += 1;
      logger.error("[appointment-reminder] falhou", {
        appointment_id: appt.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await admin.from("agent_inbox_items").insert({
        organization_id: appt.organization_id,
        kind: "message_send_stuck",
        severity: "warn",
        title: "Lembrete de agendamento não enviado",
        body:
          "Falha de infraestrutura ao tentar enviar o lembrete de WhatsApp de um agendamento. " +
          "Verifique a conexão do canal.",
        ref_kind: "appointment",
        ref_id: appt.id,
      });
    }
  }
  return result;
}

async function sendOneReminder(
  admin: ReturnType<typeof createAdminClient>,
  pool: pg.Pool,
  channel: WahaChannelAdapter,
  appt: DueAppointment,
  now: Date,
  result: ReminderResult,
): Promise<void> {
  const { data: lead } = await admin
    .from("crm_leads")
    .select("contact_id")
    .eq("id", appt.lead_id)
    .eq("organization_id", appt.organization_id)
    .single();
  const contactId = (lead as { contact_id: string } | null)?.contact_id;
  if (!contactId) return; // lead sem contato vinculado: nada a fazer, próxima rodada tenta de novo

  // Base legal LGPD do contato — fonte confiável (mesma leitura que
  // get-lead-context.ts faz para o resto do agent-engine). Sem isto,
  // `ctx.lgpd` fica null dentro do runBeforeSend e o lgpdGate vira no-op:
  // um contato JÁ anonimizado (fn_lgpd_cascade_redact_contact, que não toca
  // `appointments`) receberia o lembrete mesmo assim.
  const { data: contactRow, error: contactErr } = await admin
    .from("contacts")
    .select("source, consent, is_anonymized")
    .eq("id", contactId)
    .eq("organization_id", appt.organization_id)
    .maybeSingle();
  if (contactErr || !contactRow) return; // contato não resolvível: pula, próxima rodada tenta de novo
  // isProspecting=false: lembrete responde a um agendamento já existente do
  // lead, nunca é 1º toque frio (mesma justificativa de get-lead-context.ts).
  const lgpd = deriveLgpdFromContact(contactRow as LgpdContactFields, false);

  // Conversa mais recente do lead NESTA organização — nunca inventada
  // (regra dura nº 1). Sem conversa nenhuma não há channel_session_id nem
  // conversation_id para montar o envio: pula, a próxima rodada tenta de novo.
  const { data: conv } = await admin
    .from("conversations")
    .select("id, channel_session_id")
    .eq("contact_id", contactId)
    .eq("organization_id", appt.organization_id)
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const conversation = conv as { id: string; channel_session_id: string } | null;
  if (!conversation?.channel_session_id || !conversation.id) return;

  const body =
    `Lembrete: você tem um horário marcado para ${new Date(appt.scheduled_at).toLocaleString("pt-BR")}. ` +
    `Se precisar remarcar, é só nos avisar.`;

  const outcome = await runBeforeSend({
    pool,
    log: logger,
    tenantId: appt.organization_id,
    leadId: contactId,
    channelSessionId: conversation.channel_session_id,
    body,
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now,
    lgpd,
    // Mesmo ChannelAdapter (WAHA via CRM) que o resto do engine usa — o
    // (appointment_id, seq=1) é a chave de idempotência do send_ledger, então
    // um retry deste cron para o MESMO agendamento nunca duplica o WhatsApp.
    send: (finalBody: string) =>
      channel.send({
        tenantId: appt.organization_id,
        leadId: contactId,
        jobId: appt.id,
        seq: 1,
        conversationId: conversation.id,
        body: finalBody,
      }),
  });

  if (outcome.status === "sent") {
    await admin.from("appointments").update({ reminder_sent_at: now.toISOString() }).eq("id", appt.id);
    result.sent += 1;
  } else {
    result.vetoed += 1;
  }
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  let pool: pg.Pool;
  try {
    pool = getRequestPool();
  } catch {
    return fail("unavailable", "Lembrete de agendamento indisponível (config).", 503, { requestId });
  }

  let result: ReminderResult;
  try {
    result = await sendAppointmentReminders(createAdminClient(), pool, new Date());
  } catch (err) {
    logger.error("[appointment-reminder] falhou", { error: err instanceof Error ? err.message : String(err) });
    return fail("internal_error", "Failed to send appointment reminders.", 500, { requestId });
  }
  return ok(result, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
