/**
 * GET  /api/v1/contacts — list with search/tag/source filters + cursor pagination
 * POST /api/v1/contacts — create contact (Wave 1)
 *
 * Multi-tenancy: relies on RLS via cookie-scoped server client. Active org is
 * resolved from auth helper to stamp `organization_id` on inserts.
 *
 * MVP follow-ups:
 *  - resolveContact / merge_queue dedup pipeline (Wave 3)
 *  - HMAC-signed cursor (currently base64 only — see Spec 09 §6)
 *  - At-rest CPF encryption (encrypt_cpf RPC pending migration)
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { contactCreateSchema, contactListQuerySchema, validateRequest } from "@/lib/schemas";
import { hashCpf, encryptCpfSql } from "@/lib/contacts/cpf";
import { createClient } from "@/lib/supabase/server";
import type { Contact } from "@/lib/types/contacts";

export const dynamic = "force-dynamic";

const SELECT_COLS =
  "id, organization_id, name, display_name, email, email_normalized, phone_number, cpf_hash, birthdate, is_blocked, blocked_reason, is_anonymized, anonymized_at, is_merged_into, merged_at, consent, tags, source, source_metadata, created_at, updated_at, last_activity_at";

interface CursorPayload {
  last_activity_at: string | null;
  created_at: string;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CursorPayload;
    if (typeof parsed.id !== "string" || typeof parsed.created_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const url = new URL(req.url);
  const qsParsed = contactListQuerySchema.safeParse({
    search: url.searchParams.get("search") ?? undefined,
    tag: url.searchParams.get("tag") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!qsParsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      details: qsParsed.error.flatten().fieldErrors as Record<string, unknown>,
      requestId,
    });
  }
  const q = qsParsed.data;

  let query = supabase
    .from("contacts")
    .select(SELECT_COLS)
    .order("last_activity_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.search) {
    const s = q.search.trim();
    const digits = s.replace(/\D/g, "");
    const orParts = [
      `name.ilike.%${s}%`,
      `email.ilike.%${s}%`,
      `phone_number.ilike.%${s}%`,
    ];
    if (digits.length === 11) {
      orParts.push(`cpf_hash.eq.${hashCpf(digits)}`);
    }
    query = query.or(orParts.join(","));
  }
  if (q.tag) query = query.contains("tags", [q.tag]);
  if (q.source) query = query.eq("source", q.source);

  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) {
      return fail("invalid_cursor", "Cursor inválido.", 400, { requestId });
    }
    // Keyset on (last_activity_at DESC NULLS LAST, created_at DESC, id DESC).
    // Simplification: filter strictly by created_at < c.created_at OR
    // (created_at = c.created_at AND id < c.id). last_activity_at gap is
    // tolerable for MVP; full lex ordering is a follow-up.
    query = query.or(
      `created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id})`,
    );
  }

  const { data, error } = await query;
  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const rows = (data ?? []) as Contact[];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          last_activity_at: last.last_activity_at,
          created_at: last.created_at,
          id: last.id,
        })
      : null;

  return ok(page, {
    requestId,
    meta: { cursor: nextCursor, has_more: hasMore },
  });
}

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

  const authUser = await loadAuthUser();
  if (!authUser) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) {
    return fail("forbidden_tenant", "Sem organização ativa.", 403, { requestId });
  }

  let input;
  try {
    input = await validateRequest(contactCreateSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const insertRow: Record<string, unknown> = {
    organization_id: activeOrg.orgId,
    created_by_user_id: user.id,
    name: input.name ?? null,
    display_name: input.display_name ?? null,
    email: input.email ?? null,
    email_normalized: input.email ? input.email.trim().toLowerCase() : null,
    phone_number: input.phone_number ?? null,
    birthdate: input.birthdate ?? null,
    tags: input.tags ?? [],
    source: input.source,
    source_metadata: input.source_metadata ?? {},
    consent: input.consent ?? {},
  };

  if (input.cpf) {
    insertRow.cpf_hash = hashCpf(input.cpf);
    const enc = await encryptCpfSql(supabase, input.cpf);
    if (enc) insertRow.cpf_encrypted = enc;
  }

  const { data: created, error: insErr } = await supabase
    .from("contacts")
    .insert(insertRow)
    .select(SELECT_COLS)
    .single();

  if (insErr) {
    return fail("internal_error", insErr.message, 500, { requestId });
  }

  const contact = created as Contact;

  await supabase
    .rpc("emit_event", {
      p_event_type: "contact.created",
      p_entity_kind: "contact",
      p_entity_id: contact.id,
      p_payload: {
        source: contact.source,
        has_email: !!contact.email,
        has_phone: !!contact.phone_number,
        has_cpf: !!contact.cpf_hash,
      },
      p_metadata: { request_id: requestId, actor_user_id: user.id },
      p_organization_id: contact.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[contacts.create] emit_event failed", error.message);
    });

  await audit({
    action: "contact.created",
    actorUserId: user.id,
    organizationId: contact.organization_id,
    resourceType: "contact",
    resourceId: contact.id,
    requestId,
    metadata: { source: contact.source },
  });

  return ok({ contact, action: "created" }, { status: 201, requestId });
}
