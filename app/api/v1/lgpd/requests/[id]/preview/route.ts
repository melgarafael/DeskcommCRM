/**
 * GET /api/v1/lgpd/requests/[id]/preview
 *
 * Dry-run preview: returns COUNTS + SAMPLE (10 rows per category) of the data
 * that would be exported or redacted for this request.
 *
 * PII masking: email a***@domain, phone (**) ****-last4, CPF NEVER returned.
 * Does NOT write to DB.
 *
 * Auth: cookie session, role >= admin.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { collectExportData } from "@/lib/lgpd/export-collector";
import { maskEmail, maskPhone } from "@/lib/lgpd/mask";

export const dynamic = "force-dynamic";

const SAMPLE_LIMIT = 10;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();

  const authUser = await loadAuthUser();
  if (!authUser) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });
  }

  const isAllowed =
    authUser.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  if (!isAllowed) {
    return fail(
      "forbidden_role",
      "Apenas administradores podem acessar o preview LGPD.",
      403,
      { requestId },
    );
  }

  const { id } = await params;
  const orgId = activeOrg.orgId;
  const admin = createAdminClient();

  // Fetch lgpd_request to get contact_id and external_customer_id
  const { data: request, error: reqErr } = await admin
    .from("lgpd_requests")
    .select("id, contact_id, external_customer_id, request_type")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();

  if (reqErr) {
    return fail("internal_error", reqErr.message, 500, { requestId });
  }
  if (!request) {
    return fail("not_found", "Solicitação não encontrada.", 404, { requestId });
  }

  // collectExportData — read-only, never writes
  const payload = await collectExportData({
    organizationId: orgId,
    requestId: id,
    contactId: request.contact_id,
    externalCustomerId: request.external_customer_id,
  });

  // Build counts per category
  const counts = {
    conversations: payload.conversations.length,
    messages_total: payload.messages_count_total,
    leads: payload.leads.length,
    orders: payload.orders.length,
    activities: payload.activities.length,
    audit_entries: payload.audit_log_extract.length,
    consents: payload.consents.length,
  };

  // Build masked samples (10 rows per category, CPF never returned)
  const contact_masked = payload.contact
    ? {
        id: payload.contact.id,
        name: payload.contact.name,
        display_name: payload.contact.display_name,
        email: maskEmail(payload.contact.email),
        phone_number: maskPhone(payload.contact.phone_number),
        // cpf_present tells whether it exists — CPF value itself NEVER exposed
        cpf_present: payload.contact.cpf_present,
        birthdate: payload.contact.birthdate,
        is_blocked: payload.contact.is_blocked,
        is_anonymized: payload.contact.is_anonymized,
        tags: payload.contact.tags,
        source: payload.contact.source,
        created_at: payload.contact.created_at,
        last_activity_at: payload.contact.last_activity_at,
      }
    : null;

  const sample = {
    conversations: payload.conversations.slice(0, SAMPLE_LIMIT),
    messages_recent: payload.messages_recent.slice(0, SAMPLE_LIMIT).map((m) => ({
      ...m,
      // Mask message body if it contains likely PII patterns — keep structural info
      body: m.body ? "[masked]" : null,
    })),
    leads: payload.leads.slice(0, SAMPLE_LIMIT),
    orders: payload.orders.slice(0, SAMPLE_LIMIT),
    activities: payload.activities.slice(0, SAMPLE_LIMIT),
    audit_entries: payload.audit_log_extract.slice(0, SAMPLE_LIMIT),
    consents: payload.consents,
  };

  return ok(
    {
      request_id: id,
      request_type: request.request_type,
      no_local_footprint: payload.no_local_footprint,
      generated_at: payload.generated_at,
      contact: contact_masked,
      counts,
      sample,
    },
    { requestId },
  );
}
