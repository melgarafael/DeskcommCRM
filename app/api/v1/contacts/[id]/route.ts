/**
 * GET   /api/v1/contacts/[id] — fetch single contact (RLS-scoped).
 *   Optional CPF decrypt: requires header `X-Decrypt-Purpose: <purpose>` AND
 *   role >= manager (Spec 05 / LGPD §4). Without header the response just
 *   advertises `cpf_available`.
 *
 * PATCH /api/v1/contacts/[id] — update mutable fields. Blocked when
 *   `is_anonymized=true` (LGPD irreversibility — code `lgpd_anonymization_irreversible`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { contactPatchSchema, validateRequest } from "@/lib/schemas";
import { hashCpf, encryptCpfSql } from "@/lib/contacts/cpf";
import { createClient } from "@/lib/supabase/server";
import type { Contact } from "@/lib/types/contacts";

export const dynamic = "force-dynamic";

const SELECT_COLS =
  "id, organization_id, name, display_name, email, email_normalized, phone_number, cpf_hash, birthdate, is_blocked, blocked_reason, is_anonymized, anonymized_at, is_merged_into, merged_at, consent, tags, source, source_metadata, created_at, updated_at, last_activity_at";

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  agent: 2,
  manager: 3,
  admin: 4,
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const { data, error } = await supabase
    .from("contacts")
    .select(SELECT_COLS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) {
    return fail("not_found", "Contato não encontrado.", 404, { requestId });
  }
  const contact = data as Contact;

  const decryptPurpose = req.headers.get("x-decrypt-purpose");
  let cpfDecrypted: string | null = null;
  let cpfDecryptDenied = false;

  if (decryptPurpose && contact.cpf_hash) {
    const { data: membership } = await supabase
      .from("user_organizations")
      .select("role")
      .eq("user_id", user.id)
      .eq("organization_id", contact.organization_id)
      .is("revoked_at", null)
      .maybeSingle();

    const role = membership?.role as string | undefined;
    const rank = role ? (ROLE_RANK[role] ?? 0) : 0;
    if (rank < ROLE_RANK.manager!) {
      cpfDecryptDenied = true;
    } else {
      const { data: dec, error: decErr } = await supabase.rpc("decrypt_cpf", {
        p_contact_id: id,
      });
      if (decErr) {
        console.warn("[contacts.get] decrypt_cpf RPC unavailable", decErr.message);
      } else if (typeof dec === "string") {
        cpfDecrypted = dec;
      }
      await audit({
        action: "contact.updated", // re-purpose for read-with-decrypt? use dedicated when available
        actorUserId: user.id,
        organizationId: contact.organization_id,
        resourceType: "contact",
        resourceId: contact.id,
        requestId,
        metadata: { decrypt_purpose: decryptPurpose, success: !!cpfDecrypted },
      });
    }
  }

  return ok(
    {
      ...contact,
      cpf_available: !!contact.cpf_hash,
      cpf_decrypted: cpfDecrypted,
      cpf_decrypt_denied: cpfDecryptDenied || undefined,
    },
    { requestId },
  );
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const { data: existing, error: selErr } = await supabase
    .from("contacts")
    .select("id, organization_id, is_anonymized")
    .eq("id", id)
    .maybeSingle();

  if (selErr) {
    return fail("internal_error", selErr.message, 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Contato não encontrado.", 404, { requestId });
  }
  if (existing.is_anonymized) {
    return fail(
      "lgpd_anonymization_irreversible",
      "Contato anonimizado — edição bloqueada (LGPD).",
      403,
      { requestId },
    );
  }

  let input;
  try {
    input = await validateRequest(contactPatchSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.display_name !== undefined) patch.display_name = input.display_name;
  if (input.email !== undefined) {
    patch.email = input.email;
    patch.email_normalized = input.email ? input.email.trim().toLowerCase() : null;
  }
  if (input.phone_number !== undefined) patch.phone_number = input.phone_number;
  if (input.birthdate !== undefined) patch.birthdate = input.birthdate;
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.source !== undefined) patch.source = input.source;
  if (input.source_metadata !== undefined) patch.source_metadata = input.source_metadata;
  if (input.consent !== undefined) patch.consent = input.consent;
  if (input.cpf !== undefined) {
    patch.cpf_hash = hashCpf(input.cpf);
    const enc = await encryptCpfSql(supabase, input.cpf);
    if (enc) patch.cpf_encrypted = enc;
  }

  if (Object.keys(patch).length === 0) {
    return fail("invalid_request", "Nenhum campo para atualizar.", 400, { requestId });
  }

  patch.updated_at = new Date().toISOString();

  const { data: updated, error: updErr } = await supabase
    .from("contacts")
    .update(patch)
    .eq("id", id)
    .select(SELECT_COLS)
    .maybeSingle();

  if (updErr) {
    return fail("internal_error", updErr.message, 500, { requestId });
  }
  if (!updated) {
    return fail("not_found", "Contato não encontrado após update.", 404, { requestId });
  }

  const contact = updated as Contact;

  await supabase
    .rpc("emit_event", {
      p_event_type: "contact.updated",
      p_entity_kind: "contact",
      p_entity_id: contact.id,
      p_payload: { fields: Object.keys(patch).filter((k) => k !== "updated_at") },
      p_metadata: { request_id: requestId, actor_user_id: user.id },
      p_organization_id: contact.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[contacts.patch] emit_event failed", error.message);
    });

  await audit({
    action: "contact.updated",
    actorUserId: user.id,
    organizationId: contact.organization_id,
    resourceType: "contact",
    resourceId: contact.id,
    requestId,
    metadata: { fields: Object.keys(patch).filter((k) => k !== "updated_at") },
  });

  return ok(contact, { requestId });
}
