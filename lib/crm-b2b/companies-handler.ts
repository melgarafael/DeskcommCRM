import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { enrichCompanyFromBrasilApi } from "@/lib/crm-b2b/enrich";
import { formatCnpj, normalizeCnpj } from "@/lib/crm-b2b/normalize";
import {
  companyCreateSchema,
  companyPatchSchema,
  type CompanyCreate,
} from "@/lib/crm-b2b/schemas";

type SB = SupabaseClient;

const SELECT =
  "id, organization_id, legal_name, trade_name, cnpj, normalized_cnpj, registration_status, legal_nature, company_size, share_capital, opened_at, main_cnae_code, main_cnae_description, secondary_cnaes, street, number, complement, district, city, state, zip_code, email, phone, enrichment_status, enriched_at, enrichment_error, created_by, created_at, updated_at";

function err(
  ctx: HandlerCtx,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new ApiError(status, code, details, ctx.requestId, message);
}

export async function listCompaniesHandler(
  supabase: SB,
  ctx: HandlerCtx,
  opts: { search?: string; limit?: number } = {},
) {
  const limit = Math.min(opts.limit ?? 50, 100);
  let q = supabase
    .from("companies")
    .select(SELECT)
    .eq("organization_id", ctx.organization_id)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (opts.search?.trim()) {
    const s = `%${opts.search.trim()}%`;
    q = q.or(`trade_name.ilike.${s},legal_name.ilike.${s},cnpj.ilike.${s},normalized_cnpj.ilike.${s}`);
  }

  const { data, error } = await q;
  if (error) err(ctx, 500, "internal_error", error.message);

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { companies: page, has_more: hasMore };
}

export async function getCompanyHandler(supabase: SB, ctx: HandlerCtx, id: string) {
  const { data, error } = await supabase
    .from("companies")
    .select(SELECT)
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!data) err(ctx, 404, "not_found", "Empresa não encontrada.");

  const { data: links } = await supabase
    .from("company_people")
    .select(
      "id, person_id, job_title, department, is_decision_maker, is_primary, notes, people:person_id(id, full_name, email, normalized_name)",
    )
    .eq("organization_id", ctx.organization_id)
    .eq("company_id", id);

  const personIds = (links ?? []).map((l) => l.person_id as string).filter(Boolean);
  let contacts: unknown[] = [];
  if (personIds.length > 0) {
    const { data: cts } = await supabase
      .from("contacts")
      .select("id, person_id, phone_number, display_name, name, email, is_blocked")
      .eq("organization_id", ctx.organization_id)
      .in("person_id", personIds)
      .is("is_merged_into", null);
    contacts = cts ?? [];
  }

  return { company: data, people: links ?? [], contacts };
}

export async function createCompanyHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  raw: unknown,
) {
  const body: CompanyCreate = companyCreateSchema.parse(raw);
  const normalized = body.cnpj ? normalizeCnpj(body.cnpj) : null;
  if (body.cnpj && !normalized) err(ctx, 422, "validation_failed", "CNPJ inválido.");

  if (normalized) {
    const { data: dup } = await supabase
      .from("companies")
      .select("id")
      .eq("organization_id", ctx.organization_id)
      .eq("normalized_cnpj", normalized)
      .maybeSingle();
    if (dup) err(ctx, 409, "conflict", "Já existe empresa com este CNPJ.");
  }

  const insert = {
    organization_id: ctx.organization_id,
    legal_name: body.legal_name || null,
    trade_name: body.trade_name || body.legal_name || null,
    cnpj: normalized ? formatCnpj(normalized) : null,
    normalized_cnpj: normalized,
    email: body.email || null,
    phone: body.phone || null,
    street: body.street || null,
    number: body.number || null,
    complement: body.complement || null,
    district: body.district || null,
    city: body.city || null,
    state: body.state || null,
    zip_code: body.zip_code || null,
    enrichment_status: "pending" as const,
    created_by: actorUserId,
  };

  const { data, error } = await supabase.from("companies").insert(insert).select(SELECT).single();
  if (error) {
    if (error.code === "23505") err(ctx, 409, "conflict", "CNPJ já cadastrado.");
    err(ctx, 500, "internal_error", error.message);
  }

  await audit({
    organizationId: ctx.organization_id,
    actorUserId,
    action: "companies.created",
    resourceType: "companies",
    resourceId: data.id,
    requestId: ctx.requestId,
  });

  if (body.enrich !== false && normalized) {
    void enrichCompanyFromBrasilApi(supabase, {
      organizationId: ctx.organization_id,
      companyId: data.id,
      cnpj: normalized,
    });
  }

  return data;
}

export async function patchCompanyHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  id: string,
  raw: unknown,
) {
  const body = companyPatchSchema.parse(raw);
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "enrich" || k === "cnpj") continue;
    if (v !== undefined) patch[k] = v === "" ? null : v;
  }
  if (body.cnpj !== undefined) {
    const normalized = body.cnpj ? normalizeCnpj(body.cnpj) : null;
    if (body.cnpj && !normalized) err(ctx, 422, "validation_failed", "CNPJ inválido.");
    patch.cnpj = normalized ? formatCnpj(normalized) : null;
    patch.normalized_cnpj = normalized;
  }

  const { data, error } = await supabase
    .from("companies")
    .update(patch)
    .eq("organization_id", ctx.organization_id)
    .eq("id", id)
    .select(SELECT)
    .maybeSingle();
  if (error) err(ctx, 500, "internal_error", error.message);
  if (!data) err(ctx, 404, "not_found", "Empresa não encontrada.");

  await audit({
    organizationId: ctx.organization_id,
    actorUserId,
    action: "companies.updated",
    resourceType: "companies",
    resourceId: id,
    requestId: ctx.requestId,
  });

  if (body.enrich && data.normalized_cnpj) {
    void enrichCompanyFromBrasilApi(supabase, {
      organizationId: ctx.organization_id,
      companyId: id,
      cnpj: data.normalized_cnpj as string,
    });
  }

  return data;
}

export async function enrichCompanyHandler(
  supabase: SB,
  ctx: HandlerCtx,
  actorUserId: string,
  id: string,
) {
  const result = await enrichCompanyFromBrasilApi(supabase, {
    organizationId: ctx.organization_id,
    companyId: id,
  });
  await audit({
    organizationId: ctx.organization_id,
    actorUserId,
    action: "companies.enriched",
    resourceType: "companies",
    resourceId: id,
    requestId: ctx.requestId,
    metadata: { status: result.status },
  });
  return getCompanyHandler(supabase, ctx, id);
}
