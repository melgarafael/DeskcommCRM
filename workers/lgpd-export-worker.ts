/**
 * lgpd-export-worker — consumes `lgpd.data_request_received` events.
 *
 * Pipeline (S-08.04):
 *   1. Load lgpd_requests row (programmatic org filter).
 *   2. Move status received -> processing, attempts++ (cap at 3).
 *   3. collectExportData → varredura das tabelas que a anonimização alcança (PII-safe).
 *      Sem contagem fixa aqui: esta linha dizia "8 tabelas" muito depois de serem dezenas.
 *   4. Render PDF via @react-pdf/renderer (PT-BR, Art. 18 II).
 *   5. signPdfPades — STUB when LGPD_SIGNING_KEY missing (warning, no throw).
 *   6. Upload PDF + JSON to bucket `lgpd-exports/{org}/{request}/...`.
 *   7. Create signed URL (LGPD_EXPORT_EXPIRES_HOURS, default 72h).
 *   8. Resolve delivery email: request_payload.delivery.address || contact.email.
 *   9. sendExportEmail (Resend) — sha256(email) in logs only.
 *   10. Mark status='completed', persist result metadata (paths, sha256, signed flag,
 *       delivered_to_hash, message_id, warning).
 *   11. Emit lgpd.export_generated + lgpd.export_delivered.
 *   12. Audit both with sanitized payload.
 *
 * Failure: do NOT throw out of the handler — increment attempts and surface
 * an "error" status so the dispatcher can retry. PII never appears in error
 * messages or Sentry breadcrumbs (only ids + hashes).
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { valorDaInstalacao } from "@/lib/instalacao/config";

import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { collectExportData } from "@/lib/lgpd/export-collector";
import { findLgpdRequest } from "@/lib/lgpd/repository";
// IMPORT TARDIO, e a razão é o laço rápido do `event_log`.
//
// `lib/event-log/register-handlers.ts` — cujo próprio comentário pede "keep it
// lightweight" — importa o handler da LGPD no topo, e ele importava este
// arquivo, que importava o gerador de PDF, que arrasta `@react-pdf/renderer`
// inteiro. Resultado: TODA montagem do laço carregava a pilha de PDF só para
// registrar um handler que, na esmagadora maioria das rodadas, não roda.
//
// Isso deixou de ser só desperdício em 29/08, quando `@react-pdf/hyphenate`
// passou a declarar `exports` sem a condição `require`: sob `tsx` (que é como o
// worker roda, e diferente do vitest, que resolve pelo Vite) o import falhava,
// `carregarDeps()` caía no catch, e o laço rápido MORRIA — 10 dias e três
// releases, com a guarda 6/6 verde.
//
// O patch em `patches/` conserta a dependência e continua valendo. Este import
// tardio conserta a CAUSA: o laço deixa de depender de PDF para existir. Um
// depende de o pnpm aplicar o patch em todo ambiente; o outro, não.
import { signPdfPades, isPadesConfigured } from "@/lib/lgpd/pades-signer";
import {
  EmailNotConfigured,
  EmailSendFailed,
  hashEmail,
  sendExportEmail,
} from "@/lib/lgpd/email-delivery";
import { createAdminClient } from "@/lib/supabase/admin";
import { marcaDaSaida } from "@/lib/branding/saida";
import { perfilDaOrganizacao } from "@/lib/legal/perfil-do-pais";
import { partesDoArquivoDoTitular } from "@/lib/lgpd/copia-do-titular";

const MAX_ATTEMPTS = 3;
const BUCKET = "lgpd-exports";

function expiresHours(): number {
  const raw = process.env.LGPD_EXPORT_EXPIRES_HOURS ?? env.LGPD_EXPORT_EXPIRES_HOURS;
  const n = Number.parseInt(String(raw ?? "72"), 10);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export async function processLgpdExport(event: EventRow): Promise<HandlerResult> {
  const orgId = event.organization_id;
  const requestId =
    (event.payload?.["request_id"] as string | undefined) ?? event.entity_id ?? null;

  if (!requestId) {
    logger.warn("[lgpd-export-worker] missing request_id in event", {
      event_id: event.id,
    });
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "skipped",
      detail: "missing_request_id",
    };
  }

  const admin = createAdminClient();

  // 1. Load request.
  const req = await findLgpdRequest(orgId, requestId).catch((err: unknown) => {
    logger.error("[lgpd-export-worker] findLgpdRequest threw", {
      request_id: shortId(requestId),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  if (!req) {
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "skipped",
      detail: "request_not_found",
    };
  }

  if (req.status === "completed") {
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "skipped",
      detail: "already_completed",
    };
  }

  if (req.request_type !== "data_request") {
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "skipped",
      detail: "wrong_request_type",
    };
  }

  // 2. attempts cap + transition to processing.
  const nextAttempts = req.attempts + 1;
  if (nextAttempts > MAX_ATTEMPTS) {
    await admin
      .from("lgpd_requests")
      .update({
        status: "failed",
        error_message: "max_attempts_exceeded",
      })
      .eq("organization_id", orgId)
      .eq("id", requestId);
    await audit({
      action: "lgpd.export_failed",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: { reason: "max_attempts_exceeded", attempts: req.attempts },
      bypassedRls: true,
    });
    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "error",
      detail: "max_attempts_exceeded",
    };
  }

  await admin
    .from("lgpd_requests")
    .update({ status: "processing", attempts: nextAttempts })
    .eq("organization_id", orgId)
    .eq("id", requestId);

  try {
    // 3. Collect data. O país é lido UMA vez e vale para o PDF e para o e-mail:
    // duas leituras, se só uma falhasse, dariam ao titular duas leis (doc 88).
    const perfil = await perfilDaOrganizacao(admin, orgId);
    const data = await collectExportData({
      pais: perfil.codigo,
      // O piso do encarregado é resolvido AQUI e injetado: o coletor de LGPD
      // não consulta configuração, para a coleta sem identificador continuar
      // visitando só `organizations` (tests/invariants/agenda-meet-export).
      dpoDaInstalacao: (await valorDaInstalacao("LGPD_DPO_EMAIL")).valor?.trim() || null,
      organizationId: orgId,
      requestId,
      contactId: req.contact_id,
      externalCustomerId: req.external_customer_id,
    });

    // 4. Render PDF (with warning banner when unsigned).
    const padesConfigured = isPadesConfigured();
    const { renderLgpdPdf } = await import("@/lib/lgpd/pdf-renderer");
    const pdfBuffer = await renderLgpdPdf(data, { unsignedWarning: !padesConfigured });

    // 5. Sign (stubbed when key missing).
    const signResult = await signPdfPades(pdfBuffer);

    // 6. Upload artifacts.
    const jsonPath = `${orgId}/${requestId}/data.json`;
    const pdfPath = `${orgId}/${requestId}/report.pdf`;

    // O arquivo é o que o titular RECEBE (doc 103): o payload sem o que é da
    // equipe. O PDF acima foi desenhado do payload inteiro e não muda.
    //
    // #2576: ele sai em STREAM — seção a seção e linha a linha, direto no
    // upload. O que existia antes (a cópia do país serializada INTEIRA e jogada
    // num `Buffer`) mantinha payload, cópia profunda, string e buffer QUATRO
    // vezes o arquivo na memória no mesmo instante; agora é o payload (que o
    // PDF e os fixtures travam) e, no máximo, UMA linha. O storage-js passa o
    // Readable direto ao fetch com `duplex: half` — o corpo vai em chunked,
    // sem Buffer do arquivo inteiro em parte alguma.
    const corpoDoJson = Readable.from(
      (async function* () {
        for await (const pedaco of partesDoArquivoDoTitular(data, perfil.codigo)) {
          yield Buffer.from(pedaco, "utf-8");
        }
      })(),
    );

    const { error: jsonUploadErr } = await admin.storage
      .from(BUCKET)
      .upload(jsonPath, corpoDoJson, {
        contentType: "application/json",
        upsert: true,
      });
    if (jsonUploadErr) {
      throw new Error(`json_upload_failed: ${jsonUploadErr.message}`);
    }

    const { error: pdfUploadErr } = await admin.storage
      .from(BUCKET)
      .upload(pdfPath, signResult.signed, {
        contentType: "application/pdf",
        upsert: true,
      });
    if (pdfUploadErr) {
      throw new Error(`pdf_upload_failed: ${pdfUploadErr.message}`);
    }

    // 7. Signed URL.
    const expiresInSec = expiresHours() * 60 * 60;
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);

    const { data: signed, error: signedErr } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(pdfPath, expiresInSec);
    if (signedErr || !signed) {
      throw new Error(`signed_url_failed: ${signedErr?.message ?? "no_url"}`);
    }

    // A cópia dos dados: o `data.json` subia no mesmo diretório, mas só o PDF
    // tinha link. Portugal passou a recebê-lo pelo art. 15.º, n.º 3 (#2340); o
    // Brasil, pela declaração completa da LGPD (art. 19, II — doc 103, A).
    // Mesma validade do PDF.
    const { data: signedDados, error: signedDadosErr } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(jsonPath, expiresInSec);
    if (signedDadosErr || !signedDados) {
      throw new Error(`signed_url_json_failed: ${signedDadosErr?.message ?? "no_url"}`);
    }
    const signedUrlDados = signedDados.signedUrl;

    // 8. Resolve delivery email.
    const deliveryFromPayload = (req.request_payload as Record<string, unknown>)?.delivery as
      | Record<string, unknown>
      | undefined;
    const deliveryEmail =
      (typeof deliveryFromPayload?.address === "string"
        ? (deliveryFromPayload.address as string)
        : null) ?? data.contact?.email ?? null;

    if (!deliveryEmail) {
      // Mark as pending_review — operator must contact manually.
      await admin
        .from("lgpd_requests")
        .update({
          status: "pending_review",
          error_message: "no_delivery_email",
          result: {
            pdf_path: pdfPath,
            json_path: jsonPath,
            sha256: signResult.sha256,
            signed_pades: signResult.signed_pades,
            warning: signResult.warning ?? null,
          },
        })
        .eq("organization_id", orgId)
        .eq("id", requestId);
      await audit({
        action: "lgpd.export_generated",
        organizationId: orgId,
        resourceType: "lgpd_request",
        resourceId: requestId,
        metadata: {
          sha256: signResult.sha256,
          signed_pades: signResult.signed_pades,
          warning: signResult.warning ?? null,
          delivery: "pending_review_no_email",
        },
        bypassedRls: true,
      });
      return {
        consumer_key: "lgpd-export-worker.v1",
        status: "ok",
        detail: "pending_review_no_email",
      };
    }

    const deliveredHash = hashEmail(deliveryEmail);

    // 9. Send email (Resend). Failure here is retriable.
    let messageId: string | null = null;
    try {
      // Classe A: há organização, então o e-mail diz quem PROCESSOU — a marca
      // resolvida da org, e não a nossa. O PDF em anexo continua nomeando o
      // controlador legal, de propósito (ver `lib/lgpd/pdf-renderer.tsx`).
      const sent = await sendExportEmail({
        to: deliveryEmail,
        requestId,
        signedUrl: signed.signedUrl,
        signedUrlDados,
        expiresAt,
        marca: await marcaDaSaida(orgId),
        // O país decide a lei e o idioma do e-mail — o MESMO perfil que o coletor
        // usou; o fuso vem do coletor, que só o põe no payload fora do Brasil.
        perfil,
        fuso: data.fuso,
      });
      messageId = sent.messageId;
    } catch (err) {
      if (err instanceof EmailNotConfigured) {
        // Operator gap — mark pending_review (no retry helps).
        await admin
          .from("lgpd_requests")
          .update({
            status: "pending_review",
            error_message: "email_not_configured",
            result: {
              pdf_path: pdfPath,
              json_path: jsonPath,
              sha256: signResult.sha256,
              signed_pades: signResult.signed_pades,
              warning: signResult.warning ?? null,
              delivered_to_hash: deliveredHash,
            },
          })
          .eq("organization_id", orgId)
          .eq("id", requestId);
        await audit({
          action: "lgpd.export_generated",
          organizationId: orgId,
          resourceType: "lgpd_request",
          resourceId: requestId,
          metadata: {
            sha256: signResult.sha256,
            signed_pades: signResult.signed_pades,
            warning: "email_not_configured",
            delivered_to_hash: deliveredHash,
          },
          bypassedRls: true,
        });
        return {
          consumer_key: "lgpd-export-worker.v1",
          status: "ok",
          detail: "email_not_configured",
        };
      }
      // Generic Resend failure — set status back so cron retries.
      const detail = err instanceof EmailSendFailed ? err.message : String(err);
      logger.warn("[lgpd-export-worker] email send failed", {
        request_id: shortId(requestId),
        error_hash: sha256(detail),
      });
      await admin
        .from("lgpd_requests")
        .update({
          status: "received",
          error_message: "email_send_failed",
        })
        .eq("organization_id", orgId)
        .eq("id", requestId);
      return {
        consumer_key: "lgpd-export-worker.v1",
        status: "error",
        detail: "email_send_failed",
      };
    }

    // 10. Mark completed.
    const result = {
      pdf_path: pdfPath,
      json_path: jsonPath,
      sha256: signResult.sha256,
      signed_pades: signResult.signed_pades,
      warning: signResult.warning ?? null,
      delivered_to_hash: deliveredHash,
      message_id: messageId,
      expires_at: expiresAt.toISOString(),
    };

    await admin
      .from("lgpd_requests")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        result,
        error_message: null,
      })
      .eq("organization_id", orgId)
      .eq("id", requestId);

    // 11. Domain events.
    await admin.rpc("emit_event" as never, {
      p_event_type: "lgpd.export_generated",
      p_entity_kind: "lgpd_request",
      p_entity_id: requestId,
      p_payload: {
        request_id: requestId,
        sha256: signResult.sha256,
        signed_pades: signResult.signed_pades,
        warning: signResult.warning ?? null,
      },
      p_metadata: { source: "lgpd-export-worker" },
      p_organization_id: orgId,
    } as never);

    await admin.rpc("emit_event" as never, {
      p_event_type: "lgpd.export_delivered",
      p_entity_kind: "lgpd_request",
      p_entity_id: requestId,
      p_payload: {
        request_id: requestId,
        delivered_to_hash: deliveredHash,
        message_id: messageId,
        expires_at: expiresAt.toISOString(),
      },
      p_metadata: { source: "lgpd-export-worker" },
      p_organization_id: orgId,
    } as never);

    // 12. Audit (sanitized — no plaintext email anywhere).
    await audit({
      action: "lgpd.export_generated",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: {
        sha256: signResult.sha256,
        signed_pades: signResult.signed_pades,
        warning: signResult.warning ?? null,
        contact_id: req.contact_id,
        attempts: nextAttempts,
      },
      bypassedRls: true,
    });
    await audit({
      action: "lgpd.export_delivered",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: {
        delivered_to_hash: deliveredHash,
        message_id: messageId,
        expires_at: expiresAt.toISOString(),
        delivery: "ok",
      },
      bypassedRls: true,
    });

    logger.info("[lgpd-export-worker] export completed", {
      request_id: shortId(requestId),
      organization_id: orgId,
      sha256: signResult.sha256,
      signed_pades: signResult.signed_pades,
      delivered_to_hash: deliveredHash,
    });

    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "ok",
      detail: signResult.signed_pades ? "completed_signed" : "completed_unsigned",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // PII-safe: log error_hash, never the raw message.
    logger.error("[lgpd-export-worker] export failed", {
      request_id: shortId(requestId),
      organization_id: orgId,
      error_hash: sha256(detail),
      attempts: nextAttempts,
    });

    await admin
      .from("lgpd_requests")
      .update({
        status: nextAttempts >= MAX_ATTEMPTS ? "failed" : "received",
        error_message: detail.slice(0, 500),
      })
      .eq("organization_id", orgId)
      .eq("id", requestId);

    await audit({
      action: "lgpd.export_failed",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: {
        attempts: nextAttempts,
        error_hash: sha256(detail),
      },
      bypassedRls: true,
    });

    return {
      consumer_key: "lgpd-export-worker.v1",
      status: "error",
      detail: "export_failed_will_retry",
    };
  }
}
