/**
 * Core handlers para /api/v1/contacts (lista + get + create + patch + delete).
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
import { roleAtLeast } from "@/lib/auth/types";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { hashCpf, encryptCpfSql } from "@/lib/contacts/cpf";
import type { Contact } from "@/lib/types/contacts";
import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import type {
  ContactCreate,
  ContactPatch,
  ContactListQuery,
  ContactListQueryParams,
} from "@/lib/schemas";
import { contactListQuerySchema } from "@/lib/schemas";

type SB = SupabaseClient;

const SELECT_COLS =
  "id, organization_id, name, display_name, email, email_normalized, phone_number, cpf_hash, birthdate, is_blocked, blocked_reason, is_anonymized, anonymized_at, is_merged_into, merged_at, consent, tags, source, source_metadata, custom_fields, created_at, updated_at, last_activity_at";

interface CursorPayload {
  sort: string | null;
  id: string;
}

function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CursorPayload & {
      last_activity_at?: string | null;
      created_at?: string | null;
    };
    if (typeof parsed.id !== "string") return null;
    // Cursores legados (só created_at) ou do formato anterior (last_activity_at).
    const sort = parsed.sort ?? parsed.last_activity_at ?? parsed.created_at ?? null;
    return { sort, id: parsed.id };
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
  raw: ContactListQueryParams,
): Promise<ListContactsResult> {
  const q: ContactListQuery = contactListQuerySchema.parse(raw);
  const sortCol = q.order_by;
  const asc = q.order_dir === "asc";

  let query = supabase
    .from("contacts")
    .select(SELECT_COLS)
    .eq("organization_id", ctx.organization_id)
    // A LÁPIDE DE FUSÃO NÃO É UM CONTATO VIVO.
    //
    // `is_merged_into` marca o cadastro que foi absorvido por outro. Ele não é
    // apagado de propósito (é o que libera telefone e e-mail para o vencedor
    // herdar, e é o registro da fusão), mas ele deixou de ser uma pessoa da
    // base — e o resto do produto já o trata assim: `contacts/duplicates`, o
    // webhook de captação (`webhooks/in/[token]`) e as duas leituras de
    // `lib/channels/contato-por-telefone` filtram `is_merged_into is null`.
    // Esta listagem era a ÚNICA que não filtrava.
    //
    // Sem esta linha, a fusão parece não ter acontecido: medido pela tela em
    // 2026-09-04, logo depois de juntar dois cadastros a lista seguia mostrando
    // OS DOIS, com o mesmo telefone e ambos com status "ativo" — e quem opera
    // ou tenta juntar de novo (o diálogo de duplicados já não os oferece) ou
    // conclui que o recurso não funciona. Antes de a fusão existir na tela, a
    // coluna só era escrita por uma data migration de mão única, e por isso
    // ninguém tinha esbarrado nisto.
    .is("is_merged_into", null)
    .order(sortCol, { ascending: asc, nullsFirst: false })
    .order("id", { ascending: asc })
    .limit(q.limit + 1);

  if (q.search) {
    // ⚠️ `%` e `_` são curingas do LIKE, e `,`/`(`/`)` são delimitadores do DSL
    // do `.or()` — um nome com vírgula ("Silva, Maria") injetaria uma condição
    // extra na string do filtro. Mesmo escape de conversations/_handler.ts.
    const s = q.search.trim().replace(/[%_]/g, (m) => `\\${m}`).replace(/[,()]/g, " ");
    const digits = q.search.replace(/\D/g, "");
    const orParts = [
      `name.ilike.%${s}%`,
      // ⚠️ `display_name` ESTAVA DE FORA, e é a coluna que a tela MOSTRA.
      //
      // Contato que entra pelo WhatsApp nasce só com `display_name` (o pushName);
      // `name` fica nulo até alguém editar à mão. `resolveContactName` e o resto
      // da UI preferem `display_name` — então a busca ignorava exatamente o nome
      // que o usuário vê e digita. Medido nesta instalação: 15 de 33 contatos
      // têm `display_name` e nenhum `name`.
      //
      // Achado por um turno de agente REAL (IA 360 · wave 2): pedido para marcar
      // um retorno para "Cliente Retorno E2E", o modelo chamou esta busca, levou
      // zero resultados para um contato que EXISTE, e desistiu — a demanda
      // morreria por uma coluna faltando no OR.
      `display_name.ilike.%${s}%`,
      `email.ilike.%${s}%`,
      `phone_number.ilike.%${s}%`,
    ];
    if (digits.length >= 8) {
      // 10/11 dígitos sem DDI: no Brasil é DDD+local. Sem o 55, `3284793302`
      // não gera a variante com o 9 e o cadastro `+5532984793302` some da busca.
      const base =
        !digits.startsWith("55") && (digits.length === 10 || digits.length === 11)
          ? `55${digits}`
          : digits;
      for (const v of phoneLookupVariants(base)) {
        const d = v.replace(/\D/g, "");
        if (d && d !== digits) orParts.push(`phone_number.ilike.%${d}%`);
      }
    }
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
    const op = asc ? "gt" : "lt";
    if (c.sort) {
      query = query.or(
        `${sortCol}.${op}.${c.sort},and(${sortCol}.eq.${c.sort},id.${op}.${c.id})`,
      );
    } else {
      // Página na região de sort NULL (nulls last): pagina só por id.
      query = query.is(sortCol, null);
      query = asc ? query.gt("id", c.id) : query.lt("id", c.id);
    }
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
          sort: (last[sortCol] as string | null) ?? null,
          id: last.id,
        })
      : null;

  const { contacts, error: convErr } = await withConversas(supabase, ctx.organization_id, page);
  if (convErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, convErr);
  }

  return { contacts, cursor: nextCursor, has_more: hasMore };
}

/**
 * Anexa a conversa mais recente de cada contato — o atalho da lista para o inbox.
 * Mesma regra do quadro Kanban (`pipelines/[id]/board/route.ts:withConversas`).
 */
async function withConversas(
  supabase: SB,
  organizationId: string,
  contacts: Contact[],
): Promise<{ contacts: Contact[]; error: string | null }> {
  const contactIds = contacts.map((c) => c.id);
  if (contactIds.length === 0) return { contacts, error: null };

  const { data, error } = await supabase
    .from("conversations")
    .select("id, contact_id, last_message_preview, last_message_at, unread_count_for_assignee")
    .eq("organization_id", organizationId)
    .in("contact_id", contactIds)
    .order("last_message_at", { ascending: false, nullsFirst: false });
  if (error) return { contacts, error: error.message };

  const porContato = new Map<string, NonNullable<Contact["conversa"]>>();
  for (const row of (data ?? []) as Array<{
    id: string;
    contact_id: string;
    last_message_preview: string | null;
    last_message_at: string | null;
    unread_count_for_assignee: number | null;
  }>) {
    if (porContato.has(row.contact_id)) continue;
    porContato.set(row.contact_id, {
      id: row.id,
      preview: row.last_message_preview,
      last_message_at: row.last_message_at,
      unread: row.unread_count_for_assignee ?? 0,
    });
  }

  return {
    contacts: contacts.map((contact) => {
      const conversa = porContato.get(contact.id);
      return conversa ? { ...contact, conversa } : contact;
    }),
    error: null,
  };
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
    if (!roleAtLeast(role, "manager")) {
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

  const { contacts: enriched, error: convErr } = await withConversas(supabase, ctx.organization_id, [
    contact,
  ]);
  if (convErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, convErr);
  }
  const contactWithConversa = enriched[0] ?? contact;

  return {
    ...contactWithConversa,
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
    phone_number: input.phone_number ? canonicalPhoneBR(input.phone_number) : null,
    birthdate: input.birthdate ?? null,
    tags: input.tags ?? [],
    source: input.source,
    source_metadata: input.source_metadata ?? {},
    custom_fields: input.custom_fields ?? {},
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
  if (contact.phone_number) {
    try {
      const sessionId = await sessaoProntaParaEnvio(supabase, ctx.organization_id);
      if (sessionId) {
        await ensureConversation(supabase, ctx.organization_id, contact.id, sessionId);
      }
    } catch {
      // conversa no create é best-effort; o contato já existe
    }
  }

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
    // ⚠️ Os campos sensíveis entram aqui para existir o **`from`** da regra L-06
    // ("audit com who/what/which/when/**from/to**", exceção: "Nenhuma"). Antes
    // este select pedia só `id, organization_id, is_anonymized, tags`, e o audit
    // gravava apenas os NOMES dos campos alterados — quem quisesse saber qual
    // e-mail foi substituído não tinha onde olhar. `consent` vem junto porque o
    // patch dele passou a ser MERGE (ver abaixo), e merge precisa do estado
    // anterior.
    .select(
      "id, organization_id, is_anonymized, tags, email, phone_number, name, display_name, consent, custom_fields",
    )
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
  // `email_normalized` NÃO entra no patch — é `GENERATED ALWAYS AS
  // (lower(trim(email))) STORED` (baseline.sql:1349), e o Postgres RECUSA
  // qualquer atribuição a coluna gerada (SQLSTATE 428C9), abortando o UPDATE
  // inteiro. Efeito medido: salvar o email de um contato pela tela devolvia 500,
  // e junto morriam todos os outros campos do mesmo PATCH.
  //
  // O banco deriva a coluna sozinho — era só não escrever nela.
  if (input.email !== undefined) patch.email = input.email;
  if (input.phone_number !== undefined) {
    patch.phone_number = input.phone_number ? canonicalPhoneBR(input.phone_number) : input.phone_number;
  }
  if (input.birthdate !== undefined) patch.birthdate = input.birthdate;
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.source !== undefined) patch.source = input.source;
  if (input.source_metadata !== undefined) patch.source_metadata = input.source_metadata;
  // SUBSTITUIÇÃO, não merge — ao contrário de `consent`. O editor da tela manda
  // o objeto inteiro que ele renderizou a partir do schema do funil; um merge
  // aqui tornaria IMPOSSÍVEL apagar um campo pela tela, porque a chave removida
  // voltaria do estado anterior a cada gravação.
  if (input.custom_fields !== undefined) patch.custom_fields = input.custom_fields;
  if (input.consent !== undefined) {
    // MERGE por finalidade, nunca substituição.
    //
    // `contacts.consent` é um mapa de finalidades — a regra L-05 nomeia
    // `marketing`, `transactional` e `profiling`. Atribuir o objeto inteiro
    // (o que esta linha fazia) significa que gravar UMA finalidade APAGA as
    // outras duas: registrar o consentimento transacional de alguém apagaria em
    // silêncio o consentimento de marketing que essa pessoa tinha dado.
    //
    // Perda de consentimento não é bug barulhento — é a base legal de um envio
    // futuro sumindo sem ninguém ver.
    const anterior = ((existing as { consent?: Record<string, unknown> }).consent ?? {}) as Record<
      string,
      unknown
    >;
    patch.consent = { ...anterior, ...input.consent };
  }
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

  /**
   * O par ANTES/DEPOIS dos campos que a L-06 nomeia.
   *
   * Grafia `old_`/`new_` seguindo o precedente de `team.role_changed`
   * (app/api/v1/team/[user_id]/_shared.ts:93-94), que tem teste-guarda. O repo
   * tem mais de uma grafia para este conceito; escolher a que já é vigiada evita
   * criar a quinta.
   *
   * Só os campos SENSÍVEIS e só quando mudaram: o audit é lido por humano e
   * despejar o objeto inteiro afogaria o que importa. `consent` entra como
   * lista de finalidades tocadas, não como jsonb cru — o valor é um mapa e o
   * que se audita é qual finalidade mudou.
   */
  const antes = existing as Record<string, unknown>;
  const sensiveis: Record<string, unknown> = {};
  for (const campo of ["email", "phone_number", "name", "display_name"]) {
    if (patch[campo] !== undefined && patch[campo] !== antes[campo]) {
      sensiveis[`old_${campo}`] = antes[campo] ?? null;
      sensiveis[`new_${campo}`] = patch[campo] ?? null;
    }
  }
  if (input.consent !== undefined) {
    sensiveis.consent_scopes = Object.keys(input.consent);
  }

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
    metadata: { ...a.metadataActor, fields, ...sensiveis },
  });

  return contact;
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

function throwOnDbError(
  err: { code?: string; message: string } | null,
  requestId: string,
): void {
  if (!err) return;
  // conversations/messages apontam para contacts com ON DELETE RESTRICT.
  if (err.code === "23503") {
    throw new ApiError(
      409,
      "state_conflict",
      undefined,
      requestId,
      "Não foi possível excluir: o contato ainda tem registros vinculados.",
    );
  }
  throw new ApiError(500, "internal_error", undefined, requestId, err.message);
}

export async function deleteContactHandler(
  supabase: SB,
  ctx: HandlerCtx,
  contactId: string,
): Promise<{ id: string }> {
  const { data: existing, error: selErr } = await supabase
    .from("contacts")
    .select("id, organization_id")
    .eq("id", contactId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!existing) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Contato não encontrado.");
  }

  // Mensagens e conversas RESTRICT no contato: apagar primeiro, senão o DELETE
  // da ficha falha para qualquer lead que já falou no canal.
  const { error: msgErr } = await supabase
    .from("messages")
    .delete()
    .eq("contact_id", contactId)
    .eq("organization_id", ctx.organization_id);
  throwOnDbError(msgErr, ctx.requestId);

  const { error: convErr } = await supabase
    .from("conversations")
    .delete()
    .eq("contact_id", contactId)
    .eq("organization_id", ctx.organization_id);
  throwOnDbError(convErr, ctx.requestId);

  const { data: deleted, error: delErr } = await supabase
    .from("contacts")
    .delete()
    .eq("id", contactId)
    .eq("organization_id", ctx.organization_id)
    .select("id")
    .maybeSingle();
  throwOnDbError(delErr, ctx.requestId);
  if (!deleted) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Contato não encontrado.");
  }

  const a = actorAuditPayload(ctx.actor);

  await supabase
    .rpc("emit_event", {
      p_event_type: "contact.deleted",
      p_entity_kind: "contact",
      p_entity_id: contactId,
      p_payload: {},
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: ctx.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[contacts.delete] emit_event failed", error.message);
    });

  await audit({
    action: "contact.deleted",
    actorUserId: a.actorUserId,
    organizationId: ctx.organization_id,
    resourceType: "contact",
    resourceId: contactId,
    requestId: ctx.requestId,
    metadata: a.metadataActor,
  });

  return { id: deleted.id as string };
}
