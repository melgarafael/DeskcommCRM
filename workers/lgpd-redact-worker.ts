/**
 * lgpd-redact-worker — consumes `lgpd.redact_received` events.
 *
 * Pipeline (S-08.05):
 *   1. Load lgpd_requests row (programmatic org filter).
 *   2. Status guard (skip when already completed/failed beyond cap).
 *   3. attempts++ (cap 3 → status='failed').
 *   4. Branch by scope:
 *      - 'contact': resolve contactId (req.contact_id || external_customer_id);
 *        if absent → status='pending_review' (L-03 no local footprint).
 *        Else call RPC fn_lgpd_cascade_redact_contact (atomic TX).
 *      - 'tenant' (emergency=true, store-level uninstall): batch loop of 100
 *        contacts with checkpointed offset persisted in
 *        request_payload.progress. On finish: organizations.status='redacted'
 *        + redacted_at=now().
 *   5. Mark status='completed' (or 'partial_failure' for tenant).
 *   6. Try Nuvemshop callback (stub when adapter missing).
 *   7. Emit lgpd.redact_applied (success) or lgpd.redact_failed (error).
 *   8. Audit at request-level (the per-contact dense audit row is already
 *      inserted by the RPC).
 *
 * Zero PII in logs / Sentry — only ids + sha256 of error messages.
 */

import { createHash } from "node:crypto";

import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { perfilDaOrganizacao, PAIS_PADRAO } from "@/lib/legal/perfil-do-pais";
import { findContactByExternalId, findLgpdRequest } from "@/lib/lgpd/repository";
import { avisarTitularAposApagamento } from "@/lib/lgpd/aviso-apos-apagar";
import { cascadeRedactContact } from "@/lib/lgpd/redact-cascade";
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_ATTEMPTS = 3;
const TENANT_BATCH_SIZE = 100;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

interface TenantProgress {
  processed: number;
  batch_offset: number;
  failed_contacts: string[];
}

function readTenantProgress(payload: Record<string, unknown> | null | undefined): TenantProgress {
  const raw = (payload?.["progress"] ?? null) as Record<string, unknown> | null;
  return {
    processed: typeof raw?.["processed"] === "number" ? (raw["processed"] as number) : 0,
    batch_offset: typeof raw?.["batch_offset"] === "number" ? (raw["batch_offset"] as number) : 0,
    failed_contacts: Array.isArray(raw?.["failed_contacts"])
      ? ((raw["failed_contacts"] as unknown[]).filter((x) => typeof x === "string") as string[])
      : [],
  };
}

async function tryNuvemshopCallback(
  organizationId: string,
  payload: Record<string, unknown>,
): Promise<{ called: boolean; status: string }> {
  // Best-effort: NuvemshopAdapter.redactCustomer is not yet implemented — the
  // Nuvemshop App API does not currently expose a confirmation endpoint for
  // GDPR/LGPD callbacks; receiving the webhook is the contract. We log a
  // structured warn so observability tools surface the gap and the audit log
  // marks the callback as 'not_implemented'.
  logger.warn("[lgpd-redact-worker] nuvemshop_callback_not_implemented", {
    organization_id: organizationId,
    has_store_id: typeof payload["store_id"] !== "undefined",
  });
  return { called: false, status: "not_implemented" };
}

export async function processLgpdRedact(event: EventRow): Promise<HandlerResult> {
  const orgId = event.organization_id;
  const requestId =
    (event.payload?.["request_id"] as string | undefined) ?? event.entity_id ?? null;
  const scopeFromEvent = (event.payload?.["scope"] as string | undefined) ?? "contact";
  const emergency = event.payload?.["emergency"] === true;

  if (!requestId) {
    logger.warn("[lgpd-redact-worker] missing request_id in event", { event_id: event.id });
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: "missing_request_id",
    };
  }

  const admin = createAdminClient();

  // 1. Load request row (programmatic org filter).
  const req = await findLgpdRequest(orgId, requestId).catch((err: unknown) => {
    logger.error("[lgpd-redact-worker] findLgpdRequest threw", {
      request_id: shortId(requestId),
      error_hash: sha256(err instanceof Error ? err.message : String(err)),
    });
    return null;
  });

  if (!req) {
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: "request_not_found",
    };
  }

  if (req.status === "completed") {
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: "already_completed",
    };
  }

  if (req.status === "failed") {
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: "already_failed",
    };
  }

  const wrongType = !(
    req.request_type === "redact" || req.request_type === "store_redact"
  );
  if (wrongType) {
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: "wrong_request_type",
    };
  }

  // 2. attempts cap + transition to processing.
  const nextAttempts = req.attempts + 1;
  if (nextAttempts > MAX_ATTEMPTS) {
    await admin
      .from("lgpd_requests")
      .update({ status: "failed", error_message: "max_attempts_exceeded" })
      .eq("organization_id", orgId)
      .eq("id", requestId);

    await audit({
      action: "lgpd.redact_failed",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: { reason: "max_attempts_exceeded", attempts: req.attempts },
      bypassedRls: true,
    });

    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "error",
      detail: "max_attempts_exceeded",
    };
  }

  await admin
    .from("lgpd_requests")
    .update({ status: "processing", attempts: nextAttempts })
    .eq("organization_id", orgId)
    .eq("id", requestId);

  const scope = req.scope ?? scopeFromEvent;

  try {
    // ---------------------------------------------------------------------
    // CONTACT scope
    // ---------------------------------------------------------------------
    if (scope === "contact") {
      let contactId = req.contact_id;

      if (!contactId && req.external_customer_id) {
        const found = await findContactByExternalId(orgId, req.external_customer_id, null);
        contactId = found?.id ?? null;
      }

      if (!contactId) {
        // L-03: no local footprint — request stays as record but nothing to anonymise.
        await admin
          .from("lgpd_requests")
          .update({
            status: "pending_review",
            error_message: "no_local_footprint",
            result: { reason: "no_local_footprint" },
          })
          .eq("organization_id", orgId)
          .eq("id", requestId);

        await audit({
          action: "lgpd.redact_no_local_footprint",
          organizationId: orgId,
          resourceType: "lgpd_request",
          resourceId: requestId,
          metadata: { external_customer_id_present: Boolean(req.external_customer_id) },
          bypassedRls: true,
        });

        return {
          consumer_key: "lgpd-redact-worker.v1",
          status: "ok",
          detail: "pending_review_no_local_footprint",
        };
      }

      // ─── O AVISO DO ART. 12.º SÓ EXISTE FORA DO BRASIL ──────────────────
      //
      // Decisão de produto de 2026-10-16: os avisos novos valem só para
      // organizações de FORA do Brasil (Portugal, por exemplo). No Brasil nada
      // muda por enquanto — a promessa feita quando Portugal entrou foi "o
      // Brasil fica exatamente igual", e texto jurídico com o artigo errado
      // chegando a titular real é pior que nenhum texto.
      //
      // O país é lido AQUI, antes da cascata, porque é AQUI que o envio é
      // decidido: organização brasileira não lê o endereço do titular, não
      // avisa e não grava `art12_notice` no pedido nem na auditoria — o pedido
      // fica como na main (#2342). A rota `/art12` tem a guarda dela.
      //
      // A ordem, para quem PODE avisar, continua a de sempre: o endereço é lido
      // ANTES da cascata (o passo 1 zera `contacts.email` — é o dado que está
      // sendo apagado) e o aviso sai DEPOIS do apagamento (art. 12.º, n.º 3 do
      // RGPD). O payload do pedido serve de fallback para o pedido que veio de
      // plataforma, onde o contato pode nem ter e-mail.
      const perfil = await perfilDaOrganizacao(admin, orgId);
      const avisaTitular = perfil.codigo !== PAIS_PADRAO;

      let emailTitular: string | null = null;
      if (avisaTitular) {
        const { data: contatoAntes } = await admin
          .from("contacts")
          .select("email")
          .eq("organization_id", orgId)
          .eq("id", contactId)
          .maybeSingle();
        const emailNoPayload = req.request_payload?.["email"];
        // Duas checagens `typeof` em vez de uma pilha de `??`: o endereço vem do
        // contato (lido antes do apagamento) ou do payload, e o tipo de cada um
        // é tratado de forma explícita — mesma ordem de preferência de antes.
        const contato = contatoAntes as { email?: string | null } | null;
        const emailDoContato = contato?.email;
        if (typeof emailDoContato === "string") {
          emailTitular = emailDoContato;
        } else if (typeof emailNoPayload === "string") {
          emailTitular = emailNoPayload;
        }
      }

      const cascade = await cascadeRedactContact({
        organizationId: orgId,
        contactId,
        requestId,
      });

      if (cascade.alreadyAnonymized) {
        await admin
          .from("lgpd_requests")
          .update({
            status: "completed",
            completed_at: new Date().toISOString(),
            result: { already_anonymized: true, contact_id: contactId },
            error_message: null,
            cascaded_to: {},
          })
          .eq("organization_id", orgId)
          .eq("id", requestId);

        await audit({
          action: "lgpd.redact_skipped_already_anonymized",
          organizationId: orgId,
          resourceType: "lgpd_request",
          resourceId: requestId,
          metadata: { contact_id: contactId },
          bypassedRls: true,
        });

        return {
          consumer_key: "lgpd-redact-worker.v1",
          status: "ok",
          detail: "already_anonymized",
        };
      }

      // Best-effort callback to upstream platform.
      const callback = await tryNuvemshopCallback(orgId, req.request_payload ?? {});

      // O art. 12.º, n.º 3 (RGPD): avisar o titular DEPOIS de apagar — e só
      // fora do Brasil (ver a guarda do país acima). Best-effort de propósito:
      // o pedido já está cumprido quando aqui, e derrubar `completed` por causa
      // de um e-mail trocaria um direito exercido por uma falha que o SLA
      // registraria como atraso (#2342).
      const aviso = avisaTitular
        ? await avisarTitularAposApagamento(admin, {
            organizationId: orgId,
            requestId,
            emailTitular,
            recebidoEm: new Date(req.received_at),
          })
        : null;
      // `null` = o aviso não é do país: a chave `art12_notice` não entra nem no
      // pedido nem na auditoria, e é essa ausência que mantém o Brasil igual à
      // main.
      const art12Notice = aviso ? (aviso.enviado ? "sent" : aviso.motivo) : null;

      await admin
        .from("lgpd_requests")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          result: {
            contact_id: contactId,
            cascaded_to: cascade.counts,
            media_queued: cascade.mediaPaths.length,
            callback_status: callback.status,
            // O aviso do art. 12.º é prova do cumprimento, não enfeite: a razão
            // fica no resultado (`result.art12_notice`), com o POR QUÊ quando não saiu.
            ...(art12Notice ? { art12_notice: art12Notice } : {}),
          },
          cascaded_to: cascade.counts,
          error_message: null,
        })
        .eq("organization_id", orgId)
        .eq("id", requestId);

      // Domain event — applied (consumed by SLA monitor / dashboards).
      await admin.rpc("emit_event" as never, {
        p_event_type: "lgpd.redact_applied",
        p_entity_kind: "lgpd_request",
        p_entity_id: requestId,
        p_payload: {
          request_id: requestId,
          contact_id: contactId,
          cascaded_to: cascade.counts,
          media_queued: cascade.mediaPaths.length,
        },
        p_metadata: { source: "lgpd-redact-worker" },
        p_organization_id: orgId,
      } as never);

      // Request-level audit (cascade RPC already wrote per-contact lgpd.redact_executed).
      await audit({
        action: "lgpd.redact_completed",
        organizationId: orgId,
        resourceType: "lgpd_request",
        resourceId: requestId,
        metadata: {
          contact_id: contactId,
          cascaded_to: cascade.counts,
          media_queued: cascade.mediaPaths.length,
          callback_status: callback.status,
          attempts: nextAttempts,
          ...(art12Notice ? { art12_notice: art12Notice } : {}),
        },
        bypassedRls: true,
      });

      logger.info("[lgpd-redact-worker] contact redacted", {
        request_id: shortId(requestId),
        organization_id: orgId,
        cascaded_to: cascade.counts,
      });

      return { consumer_key: "lgpd-redact-worker.v1", status: "ok", detail: "completed" };
    }

    // ---------------------------------------------------------------------
    // TENANT scope (store-level uninstall)
    // ---------------------------------------------------------------------
    if (scope === "tenant") {
      const progress = readTenantProgress(req.request_payload);
      const aggregate = { contacts: 0, conversations: 0, messages: 0 };

      // Loop until empty batch — each iteration checkpoints progress.
      // Uses keyset-style ordering by id with offset (small batches, full table
      // is bounded by tenant size).
      while (true) {
        const { data: batch, error: batchErr } = await admin
          .from("contacts")
          .select("id")
          .eq("organization_id", orgId)
          .eq("is_anonymized", false)
          .order("id", { ascending: true })
          .range(progress.batch_offset, progress.batch_offset + TENANT_BATCH_SIZE - 1);

        if (batchErr) {
          throw new Error(`tenant_batch_select_failed: ${batchErr.message}`);
        }

        const rows = (batch ?? []) as Array<{ id: string }>;
        if (rows.length === 0) break;

        for (const row of rows) {
          try {
            const cascade = await cascadeRedactContact({
              organizationId: orgId,
              contactId: row.id,
              requestId,
            });
            if (!cascade.alreadyAnonymized) {
              aggregate.contacts += cascade.counts["contacts"] ?? 0;
              aggregate.conversations += cascade.counts["conversations"] ?? 0;
              aggregate.messages += cascade.counts["messages"] ?? 0;
            }
            progress.processed++;
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            progress.failed_contacts.push(row.id);
            logger.warn("[lgpd-redact-worker] tenant cascade single contact failed", {
              request_id: shortId(requestId),
              organization_id: orgId,
              contact_id_short: shortId(row.id),
              error_hash: sha256(detail),
            });
          }
        }

        progress.batch_offset += rows.length;

        // Persist checkpoint.
        const updatedPayload = {
          ...(req.request_payload as Record<string, unknown>),
          progress,
        };
        await admin
          .from("lgpd_requests")
          .update({ request_payload: updatedPayload })
          .eq("organization_id", orgId)
          .eq("id", requestId);

        // If the page was short-read we're done.
        if (rows.length < TENANT_BATCH_SIZE) break;
      }

      // Tenant fully processed → flip organizations.status='redacted'.
      const { error: orgUpdateErr } = await admin
        .from("organizations")
        .update({ status: "redacted", redacted_at: new Date().toISOString() })
        .eq("id", orgId);

      if (orgUpdateErr) {
        logger.warn("[lgpd-redact-worker] organizations status update failed", {
          organization_id: orgId,
          error_hash: sha256(orgUpdateErr.message),
        });
      }

      const callback = await tryNuvemshopCallback(orgId, req.request_payload ?? {});

      const failedCount = progress.failed_contacts.length;
      const finalStatus = failedCount > 0 ? "pending_review" : "completed";

      await admin
        .from("lgpd_requests")
        .update({
          status: finalStatus,
          completed_at: new Date().toISOString(),
          result: {
            scope: "tenant",
            processed: progress.processed,
            failed_contacts_count: failedCount,
            aggregate_counts: aggregate,
            callback_status: callback.status,
            organization_status: "redacted",
          },
          cascaded_to: aggregate,
          error_message: failedCount > 0 ? "partial_failure" : null,
        })
        .eq("organization_id", orgId)
        .eq("id", requestId);

      await admin.rpc("emit_event" as never, {
        p_event_type: "lgpd.redact_applied",
        p_entity_kind: "lgpd_request",
        p_entity_id: requestId,
        p_payload: {
          request_id: requestId,
          scope: "tenant",
          processed: progress.processed,
          failed_count: failedCount,
          aggregate_counts: aggregate,
        },
        p_metadata: { source: "lgpd-redact-worker", emergency },
        p_organization_id: orgId,
      } as never);

      await audit({
        action: "lgpd.tenant_redacted",
        organizationId: orgId,
        resourceType: "lgpd_request",
        resourceId: requestId,
        metadata: {
          processed: progress.processed,
          failed_count: failedCount,
          aggregate_counts: aggregate,
          callback_status: callback.status,
          attempts: nextAttempts,
          partial_failure: failedCount > 0,
        },
        bypassedRls: true,
      });

      logger.info("[lgpd-redact-worker] tenant redacted", {
        request_id: shortId(requestId),
        organization_id: orgId,
        processed: progress.processed,
        failed_count: failedCount,
      });

      return {
        consumer_key: "lgpd-redact-worker.v1",
        status: failedCount > 0 ? "error" : "ok",
        detail: failedCount > 0 ? "partial_failure" : "tenant_completed",
      };
    }

    // Unknown scope.
    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "skipped",
      detail: `unknown_scope:${scope}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[lgpd-redact-worker] cascade failed", {
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

    try {
      await admin.rpc("emit_event" as never, {
        p_event_type: "lgpd.redact_failed",
        p_entity_kind: "lgpd_request",
        p_entity_id: requestId,
        p_payload: {
          request_id: requestId,
          scope,
          attempts: nextAttempts,
          terminal: nextAttempts >= MAX_ATTEMPTS,
        },
        p_metadata: { source: "lgpd-redact-worker" },
        p_organization_id: orgId,
      } as never);
    } catch {
      // best-effort
    }

    await audit({
      action: "lgpd.redact_failed",
      organizationId: orgId,
      resourceType: "lgpd_request",
      resourceId: requestId,
      metadata: {
        attempts: nextAttempts,
        error_hash: sha256(detail),
        terminal: nextAttempts >= MAX_ATTEMPTS,
        scope,
      },
      bypassedRls: true,
    });

    return {
      consumer_key: "lgpd-redact-worker.v1",
      status: "error",
      detail: nextAttempts >= MAX_ATTEMPTS ? "redact_failed_terminal" : "redact_failed_will_retry",
    };
  }
}
