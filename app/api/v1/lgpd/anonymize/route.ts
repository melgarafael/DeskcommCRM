/**
 * POST /api/v1/lgpd/anonymize
 *
 * Irreversible cascade nullify (Spec 05 §LGPD). Only `admin` role within the
 * tenant or platform_admin can execute. Idempotent: re-anonymizing returns
 * 200 with `action: "already_anonymized"`.
 *
 * Cascade (best-effort sequential — no client-side transaction):
 *   1. contacts: nullify PII, set is_anonymized + anonymized_at, rewrite display_name
 *   2. crm_leads: append " (anonimizado)" to title (preserve PK + history)
 *   3. crm_lead_activities: redact payload to { redacted: true }
 *   4. Storage media deletion deferred to EPIC-08 worker
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { lgpdAnonymizeSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  let input;
  try {
    input = await validateRequest(lgpdAnonymizeSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Fetch contact (RLS scoped).
  const { data: existing, error: selErr } = await supabase
    .from("contacts")
    .select("id, organization_id, is_anonymized, anonymized_at")
    .eq("id", input.contact_id)
    .maybeSingle();
  if (selErr) {
    return fail("internal_error", selErr.message, 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Contato não encontrado.", 404, { requestId });
  }

  // Permission: tenant admin OR platform_admin.
  const authUser = await loadAuthUser();
  if (!authUser) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const membership = authUser.organizations.find(
    (o) => o.organization_id === existing.organization_id,
  );
  const allowed = authUser.is_platform_admin || membership?.role === "admin";
  if (!allowed) {
    return fail("forbidden_role", "Apenas admin pode anonimizar contatos (LGPD).", 403, {
      requestId,
    });
  }

  // Idempotency.
  if (existing.is_anonymized) {
    return ok(
      {
        contact_id: existing.id,
        anonymized_at: existing.anonymized_at,
        action: "already_anonymized",
      },
      { requestId },
    );
  }

  const nowIso = new Date().toISOString();
  const shortId = existing.id.slice(0, 8);

  // Step 1 — contacts.
  const { error: c1Err } = await supabase
    .from("contacts")
    .update({
      name: null,
      display_name: `Contato Anonimizado #${shortId}`,
      email: null,
      email_normalized: null,
      phone_number: null,
      cpf_encrypted: null,
      cpf_hash: null,
      birthdate: null,
      is_anonymized: true,
      anonymized_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", existing.id);
  if (c1Err) {
    return fail("internal_error", `contacts: ${c1Err.message}`, 500, { requestId });
  }

  // Step 2 — leads owned by contact (best-effort; non-fatal).
  const { data: leadRows } = await supabase
    .from("crm_leads")
    .select("id, title")
    .eq("contact_id", existing.id);
  const redactedLeadIds: string[] = [];
  for (const row of (leadRows ?? []) as { id: string; title: string | null }[]) {
    const newTitle = `${(row.title ?? "").slice(0, 20)} (anonimizado)`;
    const { error: leadErr } = await supabase
      .from("crm_leads")
      .update({ title: newTitle })
      .eq("id", row.id);
    if (leadErr) {
      console.error("[lgpd.anonymize] crm_leads update failed", leadErr.message);
    } else {
      redactedLeadIds.push(row.id);
    }
  }

  // Step 3 — activities (RLS-scoped UPDATE).
  const { error: actErr } = await supabase
    .from("crm_lead_activities")
    .update({ payload: { redacted: true } })
    .eq("contact_id", existing.id);
  if (actErr) {
    console.error("[lgpd.anonymize] crm_lead_activities update failed", actErr.message);
  }

  // Emit + audit.
  await supabase
    .rpc("emit_event", {
      p_event_type: "contact.anonymized",
      p_entity_kind: "contact",
      p_entity_id: existing.id,
      p_payload: {
        contact_id: existing.id,
        actor_user_id: user.id,
        justification: input.justification,
      },
      p_metadata: { request_id: requestId },
      p_organization_id: existing.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lgpd.anonymize] emit_event failed", error.message);
    });

  await audit({
    action: "lgpd.anonymize_executed",
    actorUserId: user.id,
    organizationId: existing.organization_id,
    resourceType: "contact",
    resourceId: existing.id,
    requestId,
    metadata: {
      contact_id: existing.id,
      justification: input.justification,
      redacted_tables: ["contacts", "crm_leads", "crm_lead_activities"],
      redacted_lead_ids: redactedLeadIds,
      storage_media_deletion: "deferred_epic_08",
    },
  });

  return ok({ contact_id: existing.id, anonymized_at: nowIso }, { requestId });
}
