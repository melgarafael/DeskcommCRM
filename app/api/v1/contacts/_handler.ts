/**
 * Core handlers para /api/v1/contacts (lista + get + create + patch).
 *
 * Reusados pelo Route Handler REST e por MCP tools (S-13.03/04).
 * - Recebem actor polimórfico (`user` | `ai_agent`).
 * - Lançam `ApiError` em caso de erro estruturado; sucesso retorna data.
 * - Audit + emit_event são responsabilidade do handler (DRY entre REST e MCP).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { hashCpf, encryptCpfSql } from "@/lib/contacts/cpf";
import type { Contact } from "@/lib/types/contacts";
import type {
  ContactCreate,
  ContactPatch,
  ContactListQuery,
} from "@/lib/schemas";

type SB = SupabaseClient;

const SELECT_COLS =
  "id, organization_id, name, display_name, email, email_normalized, phone_number, cpf_hash, birthdate, is_blocked, blocked_reason, is_anonymized, anonymized_at, is_merged_into, merged_at, consent, tags, source, source_metadata, created_at, updated_at, last_activity_at";

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  agent: 2,
  manager: 3,
  admin: 4,
};

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

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: {
      actor_type: actor.type,
      actor_id: actor.id,
      ...(actor.type === "ai_agent" && actor.api_token_id
        ? { actor_api_token_id: actor.api_token_id }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListContactsResult {
  contacts: Contact[];
  cursor: string | null;
  has_more: boolean;
}

export async function listContactsHandler(
  supabase: SB,
  ctx: HandlerCtx,
  q: ContactListQuery,
): Promise<ListContactsResult> {
  let query = supabase
    .from("contacts")
    .select(SELECT_COLS)
    .eq("organization_id", ctx.organization_id)
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
      throw new ApiError(400, "invalid_cursor", undefined, ctx.requestId, "Cursor inválido.");
    }
    query = query.or(
      `created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id})`,
    );
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
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

  return { contacts: page, cursor: nextCursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

export interface GetContactInput {
  contactId: string;
  decryptPurpose?: string | null;
}

export interface GetContactResult extends Contact {
  cpf_available: boolean;
  cpf_decrypted: string | null;
  cpf_decrypt_denied?: boolean;
}

export async function getContactHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: GetContactInput,
): Promise<GetContactResult> {
  const { data, error } = await supabase
    .from("contacts")
    .select(SELECT_COLS)
    .eq("id", input.contactId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Contato não encontrado.");
  }
  const contact = data as Contact;

  let cpfDecrypted: string | null = null;
  let cpfDecryptDenied = false;

  if (input.decryptPurpose && contact.cpf_hash && ctx.actor.type === "user") {
    const { data: membership } = await supabase
      .from("user_organizations")
      .select("role")
      .eq("user_id", ctx.actor.id)
      .eq("organization_id", contact.organization_id)
      .is("revoked_at", null)
      .maybeSingle();

    const role = membership?.role as string | undefined;
    const rank = role ? (ROLE_RANK[role] ?? 0) : 0;
    if (rank < ROLE_RANK.manager!) {
      cpfDecryptDenied = true;
    } else {
      const { data: dec, error: decErr } = await supabase.rpc("decrypt_cpf", {
        p_contact_id: input.contactId,
      });
      if (decErr) {
        console.warn("[contacts.get] decrypt_cpf RPC unavailable", decErr.message);
      } else if (typeof dec === "string") {
        cpfDecrypted = dec;
      }
      const a = actorAuditPayload(ctx.actor);
      await audit({
        action: "contact.updated",
        actorUserId: a.actorUserId,
        organizationId: contact.organization_id,
        resourceType: "contact",
        resourceId: contact.id,
        requestId: ctx.requestId,
        metadata: {
          ...a.metadataActor,
          decrypt_purpose: input.decryptPurpose,
          success: !!cpfDecrypted,
        },
      });
    }
  }

  return {
    ...contact,
    cpf_available: !!contact.cpf_hash,
    cpf_decrypted: cpfDecrypted,
    cpf_decrypt_denied: cpfDecryptDenied || undefined,
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateContactResult {
  contact: Contact;
  action: "created";
}

export async function createContactHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: ContactCreate,
): Promise<CreateContactResult> {
  const a = actorAuditPayload(ctx.actor);
  const insertRow: Record<string, unknown> = {
    organization_id: ctx.organization_id,
    created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
    name: input.name ?? null,
    display_name: input.display_name ?? null,
    email: input.email ?? null,
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
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, insErr.message);
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
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: contact.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[contacts.create] emit_event failed", error.message);
    });

  await audit({
    action: "contact.created",
    actorUserId: a.actorUserId,
    organizationId: contact.organization_id,
    resourceType: "contact",
    resourceId: contact.id,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, source: contact.source },
  });

  return { contact, action: "created" };
}

// ---------------------------------------------------------------------------
// patch
// ---------------------------------------------------------------------------

export async function patchContactHandler(
  supabase: SB,
  ctx: HandlerCtx,
  contactId: string,
  input: ContactPatch,
): Promise<Contact> {
  const { data: existing, error: selErr } = await supabase
    .from("contacts")
    .select("id, organization_id, is_anonymized, tags")
    .eq("id", contactId)
    .maybeSingle();

  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!existing) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Contato não encontrado.");
  }
  if (existing.is_anonymized) {
    throw new ApiError(
      403,
      "lgpd_anonymization_irreversible",
      undefined,
      ctx.requestId,
      "Contato anonimizado — edição bloqueada (LGPD).",
    );
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
    throw new ApiError(
      400,
      "invalid_request",
      undefined,
      ctx.requestId,
      "Nenhum campo para atualizar.",
    );
  }

  patch.updated_at = new Date().toISOString();

  const { data: updated, error: updErr } = await supabase
    .from("contacts")
    .update(patch)
    .eq("id", contactId)
    .select(SELECT_COLS)
    .maybeSingle();

  if (updErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  }
  if (!updated) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      "Contato não encontrado após update.",
    );
  }

  const contact = updated as Contact;
  const a = actorAuditPayload(ctx.actor);
  const fields = Object.keys(patch).filter((k) => k !== "updated_at");

  await supabase
    .rpc("emit_event", {
      p_event_type: "contact.updated",
      p_entity_kind: "contact",
      p_entity_id: contact.id,
      p_payload: { fields },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: contact.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[contacts.patch] emit_event failed", error.message);
    });

  if (input.tags !== undefined) {
    const prevTags: string[] = (existing as { tags?: string[] }).tags ?? [];
    const addedTags = input.tags.filter((t) => !prevTags.includes(t));
    if (addedTags.length) {
      await supabase
        .rpc("emit_event", {
          p_event_type: "contact.tag_added",
          p_entity_kind: "contact",
          p_entity_id: contact.id,
          p_payload: { added_tags: addedTags, tags: input.tags },
          p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
          p_organization_id: contact.organization_id,
        })
        .then(({ error }) => {
          if (error) console.error("[contacts.patch] emit_event failed", error.message);
        });
    }
  }

  await audit({
    action: "contact.updated",
    actorUserId: a.actorUserId,
    organizationId: contact.organization_id,
    resourceType: "contact",
    resourceId: contact.id,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, fields },
  });

  return contact;
}
