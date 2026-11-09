import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { normalizePersonName } from "@/lib/crm-b2b/normalize";
import {
  companyPersonCreateSchema,
  companyPersonPatchSchema,
  personCreateSchema,
  personPatchSchema,
} from "@/lib/crm-b2b/schemas";

type SB = SupabaseClient;

const SELECT =
  "id, organization_id, full_name, normalized_name, email, notes, created_by, created_at, updated_at";

function err(
  ctx: HandlerCtx,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new ApiError(status, code, details, ctx.requestId, message);
}

export async function listPeopleHandler(
  supabase: SB,
  ctx: HandlerCtx,
  opts: { search?: string; limit?: number } = {},
) {
  const limit = Math.min(opts.limit ?? 50, 100);
  let q = supabase
    .from("people")
    .select(SELECT)
    .eq("organization_id", ctx.organization_id)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (opts.search?.trim()) {
    const s = `%${opts.search.trim()}%`;
    q = q.or(`full_name.ilike.${s},email.ilike.${s}`);
  }

  const { data, error } = await q;
  if (error) err(ctx, 500, "internal_error", error.message);
  const people = (data ?? []) as Array<Record<string, unknown> & { id: string; email: string | null }>;
  if (people.length === 0) return { people };

  // Os e-mails da pessoa são o da ficha E os dos contatos ligados a ela
  // (issue #3198): quem só tem e-mail no contato aparecia com "—" na lista.
  // Leitura de apoio: se falhar, a lista sai só com o e-mail da ficha.
  const { data: contatos } = await supabase
    .from("contacts")
    .select("person_id, email")
    .eq("organization_id", ctx.organization_id)
    .in(
      "person_id",
      people.map((p) => p.id),
    )
    .not("email", "is", null)
    .is("is_merged_into", null);

  const porPessoa = new Map<string, string[]>();
  for (const c of (contatos ?? []) as Array<{ person_id: string; email: string }>) {
    porPessoa.set(c.person_id, [...(porPessoa.get(c.person_id) ?? []), c.email]);
  }
  return {
    people: people.map((p) => {
      const vistos = new Set<string>();
      const emails = [p.email, ...(porPessoa.get(p.id) ?? [])].filter((e): e is string => {
        if (!e) return false;
        const chave = e.toLowerCase();
        if (vistos.has(chave)) return false;
        vistos.add(chave);
        return true;
      });
      return { ...p, emails };
    }),
  };
}

export async function getPersonHandler(supabase: SB, ctx: HandlerCtx, id: string) {
  const { data, error } = await supabase
    .from("people")
    .select(SELECT)
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!data) err(ctx, 404, "not_found", "Pessoa não encontrada.");

  const { data: links } = await supabase
    .from("company_people")
    .select(
      "id, company_id, job_title, department, is_decision_maker, is_primary, companies:company_id(id, trade_name, legal_name, cnpj)",
    )
    .eq("organization_id", ctx.organization_id)
    .eq("person_id", id);

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, phone_number, display_name, name, email, is_blocked, person_id")
    .eq("organization_id", ctx.organization_id)
    .eq("person_id", id)
    .is("is_merged_into", null);

  return { person: data, companies: links ?? [], contacts: contacts ?? [] };
}

export async function createPersonHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  raw: unknown,
) {
  const body = personCreateSchema.parse(raw);
  const insert = {
    organization_id: ctx.organization_id,
    full_name: body.full_name,
    normalized_name: normalizePersonName(body.full_name),
    email: body.email || null,
    notes: body.notes || null,
    created_by: actorUserId,
  };

  const { data, error } = await supabase.from("people").insert(insert).select(SELECT).single();
  if (error) err(ctx, 500, "internal_error", error.message);

  if (body.company_id) {
    const { error: linkErr } = await supabase.from("company_people").insert({
      organization_id: ctx.organization_id,
      company_id: body.company_id,
      person_id: data.id,
      job_title: body.job_title || null,
      department: body.department || null,
      is_decision_maker: body.is_decision_maker ?? false,
      is_primary: body.is_primary ?? false,
    });
    if (linkErr && linkErr.code !== "23505") {
      // Desfaz a pessoa recém-criada: sem isso o 422 deixava a pessoa gravada
      // e o "tentar de novo" da tela criava uma segunda (issue #3198).
      await supabase
        .from("people")
        .delete()
        .eq("organization_id", ctx.organization_id)
        .eq("id", data.id);
      err(ctx, 422, "validation_failed", linkErr.message);
    }
  }

  await audit({
    organizationId: ctx.organization_id,
    actorUserId,
    action: "people.created",
    resourceType: "people",
    resourceId: data.id,
    requestId: ctx.requestId,
  });

  return data;
}

export async function patchPersonHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  id: string,
  raw: unknown,
) {
  const body = personPatchSchema.parse(raw);
  const patch: Record<string, unknown> = {};
  if (body.full_name !== undefined) {
    patch.full_name = body.full_name;
    patch.normalized_name = normalizePersonName(body.full_name);
  }
  if (body.email !== undefined) patch.email = body.email || null;
  if (body.notes !== undefined) patch.notes = body.notes;

  const { data, error } = await supabase
    .from("people")
    .update(patch)
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .select(SELECT)
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!data) err(ctx, 404, "not_found", "Pessoa não encontrada.");

  await audit({
    organizationId: ctx.organization_id,
    actorUserId,
    action: "people.updated",
    resourceType: "people",
    resourceId: id,
    requestId: ctx.requestId,
  });
  return data;
}

export async function linkCompanyPersonHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  raw: unknown,
) {
  const body = companyPersonCreateSchema.parse(raw);
  const { data, error } = await supabase
    .from("company_people")
    .insert({
      organization_id: ctx.organization_id,
      company_id: body.company_id,
      person_id: body.person_id,
      job_title: body.job_title || null,
      department: body.department || null,
      is_decision_maker: body.is_decision_maker ?? false,
      is_primary: body.is_primary ?? false,
      notes: body.notes || null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") err(ctx, 409, "conflict", "Vínculo já existe.");
    err(ctx, 422, "validation_failed", error.message);
  }

  await audit({
    organizationId: ctx.organization_id,
    actorUserId,
    action: "company_people.linked",
    resourceType: "company_people",
    resourceId: data.id,
    requestId: ctx.requestId,
  });
  return data;
}

export async function patchCompanyPersonHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  id: string,
  raw: unknown,
) {
  const body = companyPersonPatchSchema.parse(raw);
  const { data, error } = await supabase
    .from("company_people")
    .update(body)
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!data) err(ctx, 404, "not_found", "Vínculo não encontrado.");

  await audit({
    organizationId: ctx.organization_id,
    actorUserId,
    action: "company_people.updated",
    resourceType: "company_people",
    resourceId: id,
    requestId: ctx.requestId,
  });
  return data;
}

export async function linkContactToPersonHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  contactId: string,
  personId: string | null,
) {
  if (personId) {
    const { data: person } = await supabase
      .from("people")
      .select("id")
      .eq("organization_id", ctx.organization_id)
      .eq("id", personId)
      .maybeSingle();
    if (!person) err(ctx, 404, "not_found", "Pessoa não encontrada.");
  }

  const { data, error } = await supabase
    .from("contacts")
    .update({ person_id: personId })
    .eq("organization_id", ctx.organization_id)
    .eq("id", contactId)
    .select("id, person_id, phone_number, display_name")
    .maybeSingle();

  if (error) err(ctx, 422, "validation_failed", error.message);
  if (!data) err(ctx, 404, "not_found", "Contato não encontrado.");

  await audit({
    organizationId: ctx.organization_id,
    actorUserId,
    action: "contacts.person_linked",
    resourceType: "contacts",
    resourceId: contactId,
    requestId: ctx.requestId,
    metadata: { person_id: personId },
  });
  return data;
}

/**
 * Desfaz o vínculo pessoa ↔ empresa (issue #3198). A policy
 * `company_people_delete` existia desde a 0448 com piso `manager` — o mesmo
 * de criar o vínculo —, faltava a rota. Apaga só a linha da tabela de junção:
 * a pessoa e a empresa continuam cadastradas.
 */
export async function unlinkCompanyPersonHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  id: string,
) {
  const { data, error } = await supabase
    .from("company_people")
    .delete()
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .select("id, company_id, person_id")
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!data) err(ctx, 404, "not_found", "Vínculo não encontrado.");

  await audit({
    organizationId: ctx.organization_id,
    actorUserId,
    action: "company_people.unlinked",
    resourceType: "company_people",
    resourceId: id,
    requestId: ctx.requestId,
    metadata: { company_id: data.company_id, person_id: data.person_id },
  });
  return data;
}

/**
 * A pessoa ligada a um contato, com as empresas dela (issue #3198) — o que a
 * ficha do contato mostra. `person: null` quando o contato ainda não foi
 * ligado (o caso de todo lead que chega pelo WhatsApp).
 */
export async function getContactPersonHandler(supabase: SB, ctx: HandlerCtx, contactId: string) {
  const { data: contact, error } = await supabase
    .from("contacts")
    .select("id, person_id")
    .eq("organization_id", ctx.organization_id)
    .eq("id", contactId)
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!contact) err(ctx, 404, "not_found", "Contato não encontrado.");
  if (!contact.person_id) return { person: null, companies: [] };

  const { data: person } = await supabase
    .from("people")
    .select("id, full_name, email")
    .eq("organization_id", ctx.organization_id)
    .eq("id", contact.person_id)
    .maybeSingle();
  if (!person) return { person: null, companies: [] };

  const { data: links } = await supabase
    .from("company_people")
    .select("id, job_title, is_decision_maker, companies:company_id(id, trade_name, legal_name)")
    .eq("organization_id", ctx.organization_id)
    .eq("person_id", person.id);

  return { person, companies: links ?? [] };
}
