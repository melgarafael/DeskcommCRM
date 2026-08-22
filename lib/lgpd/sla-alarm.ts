/**
 * LGPD SLA alarm dispatcher.
 *
 * Triggered by the lgpd-sla-watcher cron (S-08.08) when a request is
 * approaching or past its D+5 / D+10 threshold.
 *
 * Privacy rules (L-08):
 *  - Sentry payload: zero PII — only ids, counts, thresholds.
 *  - DPO email: recipient address from DB column or env, never logged in plaintext.
 *  - request_payload.last_alarm_at updated as fire-once-per-24h dedup guard.
 */

import * as Sentry from "@sentry/nextjs";

import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/resend";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import type { LgpdRequest } from "./types";

export type AlarmThreshold = "data_request_d5" | "redact_d10";

export interface TriggerSlaAlarmArgs {
  request: LgpdRequest;
  threshold: AlarmThreshold;
  organizationDpoEmail?: string | null;
  /**
   * `organizations.display_name`, quando o chamador o tem. Aqui o fallback era
   * borda de verdade — ao contrário do irmão em `email-delivery.ts`, o cron
   * SEMPRE passava este campo (`app/api/v1/cron/lgpd-sla-watcher/route.ts`), e
   * a coluna é `NOT NULL` no schema (`supabase/baseline.sql:1750`). Os dois
   * `?? "SonghaiCRM"` se pareciam e não eram a mesma coisa; tratá-los com a
   * mesma urgência teria errado a prioridade.
   */
  organizationName?: string | null;
  /**
   * A marca resolvida da instalação/organização. Substitui o antigo literal e
   * pinta o botão — sem ela o alarme sairia com a cor de outro produto.
   */
  marca: MarcaDeSaida;
}

export interface TriggerSlaAlarmResult {
  alarmed: boolean;
  sentry: boolean;
  email: boolean;
  reason?: string;
}

const DEDUP_MS = 24 * 60 * 60 * 1_000; // 24 h

export async function triggerSlaAlarm(
  args: TriggerSlaAlarmArgs,
): Promise<TriggerSlaAlarmResult> {
  const { request, threshold, organizationDpoEmail, organizationName, marca } = args;

  // ──────────────────────────────────────────────────────────────────────────
  // 1. 24-hour dedup guard
  // ──────────────────────────────────────────────────────────────────────────
  const lastAlarmRaw = request.request_payload?.last_alarm_at;
  if (lastAlarmRaw && typeof lastAlarmRaw === "string") {
    const lastAlarmMs = new Date(lastAlarmRaw).getTime();
    if (!Number.isNaN(lastAlarmMs) && Date.now() - lastAlarmMs < DEDUP_MS) {
      return { alarmed: false, sentry: false, email: false, reason: "dedup_24h" };
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Compute days overdue (best-effort; MVP uses calendar days as approx)
  // ──────────────────────────────────────────────────────────────────────────
  const dueAtMs = new Date(request.due_at).getTime();
  const nowMs = Date.now();
  const daysOverdue = Math.round((nowMs - dueAtMs) / 86_400_000);

  const daysToDue = -daysOverdue; // negative = overdue

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Sentry warning — zero PII in payload
  // ──────────────────────────────────────────────────────────────────────────
  let sentryOk = false;
  try {
    Sentry.captureMessage("LGPD SLA threshold reached", {
      level: "warning",
      tags: {
        request_id: request.id,
        organization_id: request.organization_id,
        request_type: request.request_type,
        threshold,
      },
      extra: {
        received_at: request.received_at,
        due_at: request.due_at,
        attempts: request.attempts,
        days_overdue: daysOverdue,
        status: request.status,
      },
    });
    sentryOk = true;
  } catch (err) {
    console.warn("[lgpd-sla-alarm] Sentry.captureMessage failed", err);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Email DPO
  // ──────────────────────────────────────────────────────────────────────────
  const recipientEmail = organizationDpoEmail || env.LGPD_DPO_EMAIL;
  let emailOk = false;

  if (!recipientEmail) {
    console.warn("[lgpd-sla-alarm] dpo_email_missing — skipping email for request", request.id);
  } else {
    try {
      const shortId = request.id.slice(0, 8);
      const orgName = escapeHtml(organizationName || marca.nome);
      const appUrl = env.NEXT_PUBLIC_APP_URL;
      const requestUrl = `${appUrl}/app/lgpd/requests/${request.id}`;

      const subject = `[LGPD] Solicitação ${shortId} próxima do vencimento`;

      const thresholdLabel =
        threshold === "data_request_d5"
          ? "D+5 (acesso a dados)"
          : "D+10 (anonimização/exclusão)";

      const dueFmt = new Date(request.due_at).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });

      // `#dc2626` FICA, e não vira o accent: é semântica de ALERTA, não marca.
      // Um atraso que aparece em verde-sálvia porque o revendedor escolheu
      // verde deixa de comunicar urgência — a cor aqui é a informação.
      const overdueNote =
        daysOverdue > 0
          ? `<p style="color:#dc2626;font-weight:600;">⚠ Esta solicitação está ${daysOverdue} dia(s) em atraso.</p>`
          : `<p>O prazo vence em <strong>${dueFmt}</strong>.</p>`;

      const html = `<!doctype html>
<html lang="pt-BR">
<body style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:${NEUTROS_DE_SAIDA.texto};line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin:0 0 12px;font-size:18px;">[LGPD] Alerta de SLA — Solicitação #${shortId}</h2>
  <p>Olá,</p>
  <p>A solicitação LGPD <strong>#${shortId}</strong> de <strong>${orgName}</strong> atingiu o limiar <strong>${thresholdLabel}</strong>.</p>
  ${overdueNote}
  <p>Status atual: <code>${request.request_type}</code> / <code>${request.status}</code></p>
  <p style="margin:24px 0;">
    <a href="${requestUrl}" style="background:${marca.accent};color:${marca.accentFg};padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Ver solicitação no painel</a>
  </p>
  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">Base legal: LGPD Lei nº 13.709/2018, Art. 18. SLA obrigatório conforme regulamentação vigente.</p>
</body>
</html>`;

      // Texto puro não escapa: `&amp;` no corpo de um alarme é ruído.
      const text = `[LGPD] Alerta de SLA — Solicitação #${shortId}

A solicitação LGPD #${shortId} de ${organizationName || marca.nome} atingiu o limiar ${thresholdLabel}.
${daysOverdue > 0 ? `Esta solicitação está ${daysOverdue} dia(s) em atraso.` : `Prazo: ${dueFmt}.`}

Status: ${request.request_type} / ${request.status}

Acesse: ${requestUrl}

Base legal: LGPD Lei nº 13.709/2018, Art. 18.`;

      const result = await sendEmail({
        to: recipientEmail,
        subject,
        html,
        text,
        fromName: marca.nome,
        tags: [
          { name: "kind", value: "lgpd_sla_alarm" },
          { name: "threshold", value: threshold },
          { name: "request_short", value: shortId },
        ],
      });

      emailOk = result.ok;
      if (!result.ok) {
        console.warn("[lgpd-sla-alarm] email send failed", result.error, result.details);
      }
    } catch (err) {
      console.warn("[lgpd-sla-alarm] email exception", err);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Update request_payload.last_alarm_at (programmatic org filter)
  // ──────────────────────────────────────────────────────────────────────────
  try {
    const supabaseAdmin = createAdminClient();
    const { error } = await supabaseAdmin.rpc("jsonb_set_last_alarm_at", {
      p_id: request.id,
      p_organization_id: request.organization_id,
    });

    // RPC may not exist yet — fall back to raw update
    if (error) {
      await supabaseAdmin
        .from("lgpd_requests")
        .update({
          request_payload: {
            ...((request.request_payload as Record<string, unknown>) ?? {}),
            last_alarm_at: new Date().toISOString(),
          },
        })
        .eq("id", request.id)
        .eq("organization_id", request.organization_id); // programmatic filter — never from body
    }
  } catch (err) {
    console.warn("[lgpd-sla-alarm] failed to update last_alarm_at", err);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Audit
  // ──────────────────────────────────────────────────────────────────────────
  const alarmed = sentryOk || emailOk;
  try {
    await audit({
      action: "lgpd.sla_alarm_triggered",
      organizationId: request.organization_id,
      resourceType: "lgpd_request",
      resourceId: request.id,
      bypassedRls: true,
      metadata: {
        threshold,
        days_to_due: daysToDue,
        sentry: sentryOk,
        email: emailOk,
      },
    });
  } catch (err) {
    console.warn("[lgpd-sla-alarm] audit write failed", err);
  }

  return { alarmed, sentry: sentryOk, email: emailOk };
}

/**
 * O nome da organização e a marca passaram a vir de campos que uma pessoa
 * digita numa tela (`organizations.display_name`, `settings.branding`) — então
 * entram no HTML escapados. Antes desta fase o pior caso era o literal
 * `"SonghaiCRM"`.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
