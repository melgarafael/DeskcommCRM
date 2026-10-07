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
import { sendEmail } from "@/lib/email/roteador";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { citacaoDaLei, PAIS_PADRAO, perfilDoPais, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";
import { diasAtePrazo, diasDeAtraso, prazoEmBr } from "./sla";
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
   * `?? "DeskcommCRM"` se pareciam e não eram a mesma coisa; tratá-los com a
   * mesma urgência teria errado a prioridade.
   */
  organizationName?: string | null;
  /**
   * A marca resolvida da instalação/organização. Substitui o antigo literal e
   * pinta o botão — sem ela o alarme sairia com a cor de outro produto.
   */
  marca: MarcaDeSaida;
  /**
   * `organizations.country`, lido na MESMA consulta do watcher que já traz o
   * encarregado — nenhuma leitura a mais por pedido. `null`/ausente = Brasil,
   * com o texto de sempre. Fora do Brasil o alarme não afirma a LGPD (doc 88).
   * Obrigatória de propósito: quem esquecer de passá-la recebe erro de tipo, e
   * não o alarme brasileiro calado numa organização de Portugal.
   */
  country: string | null;
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
  const perfil = perfilDoPais(args.country);
  const noBrasil = perfil.codigo === PAIS_PADRAO;

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
  // 2. Dias de atraso — contados em DIAS CIVIS, no eixo em que o prazo foi
  //    contado. Ver `lib/lgpd/sla.ts`: `due_at` é a meia-noite UTC de um dia
  //    útil, e o prazo vai até o FIM desse dia.
  //
  //    A versão anterior (`Math.round((now - due_at) / 86_400_000)`) errava por
  //    dois motivos somados: media milissegundos — que a oeste de UTC já são o
  //    dia seguinte — e arredondava meio dia para cima. Efeito medido em São
  //    Paulo, prazo no dia 05/10: às 09h de 05/10 (12h UTC) o e-mail dizia
  //    "1 dia(s) em atraso" ao lado de "o prazo vence em 04/10, 21:00" — dois
  //    números que não podem estar certos ao mesmo tempo, e o primeiro é o que
  //    o DPO lê.
  // ──────────────────────────────────────────────────────────────────────────
  const daysOverdue = diasDeAtraso(request.due_at, new Date());

  const daysToDue = diasAtePrazo(request.due_at, new Date()); // negativo = atrasado

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
  const recipientEmail =
    organizationDpoEmail || (await valorDaInstalacao("LGPD_DPO_EMAIL")).valor;
  let emailOk = false;

  if (!recipientEmail) {
    console.warn("[lgpd-sla-alarm] dpo_email_missing — skipping email for request", request.id);
  } else {
    try {
      const shortId = request.id.slice(0, 8);
      const orgName = escapeHtml(organizationName || marca.nome);
      const appUrl = env.NEXT_PUBLIC_APP_URL;
      // Porta neutra, não `/app` nem o hub: a empresa pode ser suspensa ou
      // reativada entre o envio e o clique, e quem decide é o clique
      // (`app/lgpd/pedido/[id]/route.ts`).
      const requestUrl = `${appUrl}/lgpd/pedido/${request.id}`;

      // O Brasil fica byte a byte igual; fora dele, o rótulo não nomeia lei.
      // `store_redact` é a Nuvemshop avisando que o lojista desinstalou o app
      // (`webhooks/nuvemshop/store-redact`): não é pedido de titular, e o prazo
      // do art. 12.º, n.º 3 do RGPD não o rege.
      const daLoja = !noBrasil && request.request_type === "store_redact";
      const etiqueta = noBrasil ? "[LGPD]" : daLoja ? "[Apagamento da loja]" : "[Pedido de titular]";
      const solicitacao = noBrasil ? "A solicitação LGPD" : "A solicitação";
      const rodapeForaDoBrasil = daLoja ? "Prazo interno do sistema." : prazoInternoForaDoBrasil(perfil);
      const rodapeHtml = noBrasil
        ? "Base legal: LGPD Lei nº 13.709/2018, Art. 18. SLA obrigatório conforme regulamentação vigente."
        : rodapeForaDoBrasil;
      const rodapeTexto = noBrasil ? "Base legal: LGPD Lei nº 13.709/2018, Art. 18." : rodapeForaDoBrasil;

      const subject = `${etiqueta} Solicitação ${shortId} próxima do vencimento`;

      const thresholdLabel =
        threshold === "data_request_d5"
          ? "D+5 (acesso a dados)"
          : "D+10 (anonimização/exclusão)";

      // A DATA vem do dia civil que a coluna guarda, não do instante com fuso:
      // `toLocaleString` com `timeZone: America/Sao_Paulo` devolvia o dia
      // ANTERIOR (a meia-noite UTC do dia 05 é 21:00 do dia 04 em São Paulo).
      // Ver `prazoEmBr` — e, junto, `diaDoPrazo`.
      const dueFmt = prazoEmBr(request.due_at) ?? new Date(request.due_at).toISOString().slice(0, 10);

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
  <h2 style="margin:0 0 12px;font-size:18px;">${etiqueta} Alerta de SLA — Solicitação #${shortId}</h2>
  <p>Olá,</p>
  <p>${solicitacao} <strong>#${shortId}</strong> de <strong>${orgName}</strong> atingiu o limiar <strong>${thresholdLabel}</strong>.</p>
  ${overdueNote}
  <p>Status atual: <code>${request.request_type}</code> / <code>${request.status}</code></p>
  <p style="margin:24px 0;">
    <a href="${requestUrl}" style="background:${marca.accent};color:${marca.accentFg};padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Ver solicitação no painel</a>
  </p>
  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">${rodapeHtml}</p>
</body>
</html>`;

      // Texto puro não escapa: `&amp;` no corpo de um alarme é ruído.
      const text = `${etiqueta} Alerta de SLA — Solicitação #${shortId}

${solicitacao} #${shortId} de ${organizationName || marca.nome} atingiu o limiar ${thresholdLabel}.
${daysOverdue > 0 ? `Esta solicitação está ${daysOverdue} dia(s) em atraso.` : `Prazo: ${dueFmt}.`}

Status: ${request.request_type} / ${request.status}

Acesse: ${requestUrl}

${rodapeTexto}`;

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
 * O rodapé do alarme fora do Brasil: o prazo do sistema é INTERNO e mais curto
 * que o legal. O sufixo do RGPD só sai quando a lei do país é o RGPD revisado;
 * país sem citação revisada não ganha lei nenhuma afirmada.
 */
function prazoInternoForaDoBrasil(perfil: PerfilDoPais): string {
  const rgpd = perfil.lei?.nome === "RGPD" && citacaoDaLei(perfil) !== null;
  return `Prazo interno do sistema, mais curto que o prazo legal${rgpd ? " (RGPD: um mês, art. 12.º, n.º 3)" : ""}.`;
}

/**
 * O nome da organização e a marca passaram a vir de campos que uma pessoa
 * digita numa tela (`organizations.display_name`, `settings.branding`) — então
 * entram no HTML escapados. Antes desta fase o pior caso era o literal
 * `"DeskcommCRM"`.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
