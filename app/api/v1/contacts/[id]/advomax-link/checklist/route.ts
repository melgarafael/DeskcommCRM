import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
interface RouteCtx { params: Promise<{ id: string }> }

const scopeSchema = z.object({
  processo_codigo: z.coerce.number().int().positive(),
  tipo_acao_codigo: z.coerce.number().int().positive(),
}).strict();
const completionSchema = scopeSchema.extend({ item_id: z.string().uuid(), completed: z.boolean() }).strict();
const templateSchema = z.object({
  processo_codigo: z.number().int().positive(),
  tipo_acao_codigo: z.number().int().positive(),
  nome: z.string().trim().min(1).max(120),
  itens: z.array(z.object({ label: z.string().trim().min(1).max(180), required: z.boolean().default(true) }).strict()).min(1).max(50),
}).strict();

async function contexto(id: string, orgId: string) {
  const supabase = await createClient();
  const [{ data: contact, error: contactError }, { data: link, error: linkError }] = await Promise.all([
    supabase.from("contacts").select("id").eq("organization_id", orgId).eq("id", id).maybeSingle(),
    supabase.from("advomax_contact_links" as never).select("pessoa_codigo,status").eq("organization_id", orgId).eq("contact_id", id).maybeSingle(),
  ]);
  if (contactError || linkError) return { supabase, error: fail("internal_error", "Não foi possível validar o contexto jurídico.", 500) };
  if (!contact) return { supabase, error: fail("not_found", "Contato não encontrado.", 404) };
  const typed = link as { pessoa_codigo: number; status: string } | null;
  if (!typed || typed.status !== "linked") return { supabase, error: fail("conflict", "Vincule a Pessoa antes de usar o checklist.", 409) };
  return { supabase, pessoaCodigo: typed.pessoa_codigo, error: null };
}

async function processoValido(pessoaCodigo: number, processoCodigo: number, tipoAcaoCodigo: number, authz: { user: { email: string }; org: { orgId: string } }) {
  if (!env.ADVOMAX_API_URL.trim() || !env.ADVOMAX_CRM_INTEGRATION_KEY.trim()) return false;
  const response = await fetch(`${env.ADVOMAX_API_URL.replace(/\/$/, "")}/integracoes/crm/pessoas/${pessoaCodigo}/processos`, {
    headers: { "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY, "X-CRM-User-Email": authz.user.email, "X-CRM-Organization-Id": authz.org.orgId },
    cache: "no-store", signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!response?.ok) return false;
  const rows = await response.json().catch(() => null);
  return Array.isArray(rows) && rows.some((row) => row?.codigo === processoCodigo && row?.tipoAcaoCodigo === tipoAcaoCodigo);
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_document_checklist" });
  if (!authz.ok) return authz.response;
  const parsed = scopeSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return fail("validation_failed", "Processo ou tipo de ação inválido.", 422, { requestId });
  const { id } = await ctx.params;
  const scoped = await contexto(id, authz.org.orgId);
  if (scoped.error) return scoped.error;
  if (!(await processoValido(scoped.pessoaCodigo!, parsed.data.processo_codigo, parsed.data.tipo_acao_codigo, authz))) {
    return fail("forbidden", "Processo não pertence à Pessoa vinculada.", 403, { requestId });
  }
  const { data: template, error: templateError } = await scoped.supabase.from("crm_document_checklist_templates" as never)
    .select("id,name").eq("organization_id", authz.org.orgId).eq("advomax_tipo_acao_codigo", parsed.data.tipo_acao_codigo).eq("active", true).maybeSingle();
  if (templateError) return fail("internal_error", "Não foi possível consultar o checklist.", 500, { requestId });
  if (!template) return ok({ template: null, items: [] }, { requestId });
  const templateRow = template as { id: string; name: string };
  const [{ data: items, error: itemsError }, { data: completions, error: completionsError }] = await Promise.all([
    scoped.supabase.from("crm_document_checklist_items" as never).select("id,label,required,position").eq("organization_id", authz.org.orgId).eq("template_id", templateRow.id).order("position"),
    scoped.supabase.from("crm_document_checklist_completions" as never).select("item_id,completed,completed_at").eq("organization_id", authz.org.orgId).eq("processo_codigo", parsed.data.processo_codigo),
  ]);
  if (itemsError || completionsError) return fail("internal_error", "Não foi possível carregar os itens do checklist.", 500, { requestId });
  const done = new Map(((completions ?? []) as unknown as Array<{ item_id: string; completed: boolean; completed_at: string | null }>).map((row) => [row.item_id, row]));
  return ok({ template: templateRow, items: ((items ?? []) as unknown as Array<{ id: string; label: string; required: boolean; position: number }>).map((item) => ({ ...item, completed: done.get(item.id)?.completed === true, completed_at: done.get(item.id)?.completed_at ?? null })) }, { requestId });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "advomax_document_checklist" });
  if (!authz.ok) return authz.response;
  const parsed = completionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Atualização inválida.", 422, { requestId });
  const { id } = await ctx.params;
  const scoped = await contexto(id, authz.org.orgId); if (scoped.error) return scoped.error;
  if (!(await processoValido(scoped.pessoaCodigo!, parsed.data.processo_codigo, parsed.data.tipo_acao_codigo, authz))) return fail("forbidden", "Processo não pertence à Pessoa vinculada.", 403, { requestId });
  const { data: item } = await scoped.supabase.from("crm_document_checklist_items" as never).select("id,template_id").eq("organization_id", authz.org.orgId).eq("id", parsed.data.item_id).maybeSingle();
  if (!item) return fail("not_found", "Item de checklist não encontrado.", 404, { requestId });
  const itemRow = item as { id: string; template_id: string };
  const { data: template } = await scoped.supabase.from("crm_document_checklist_templates" as never).select("id").eq("organization_id", authz.org.orgId).eq("id", itemRow.template_id).eq("advomax_tipo_acao_codigo", parsed.data.tipo_acao_codigo).eq("active", true).maybeSingle();
  if (!template) return fail("conflict", "Item não pertence ao checklist deste tipo de ação.", 409, { requestId });
  const now = new Date().toISOString();
  const { error } = await scoped.supabase.from("crm_document_checklist_completions" as never).upsert({ organization_id: authz.org.orgId, contact_id: id, pessoa_codigo: scoped.pessoaCodigo, processo_codigo: parsed.data.processo_codigo, item_id: parsed.data.item_id, completed: parsed.data.completed, completed_by: parsed.data.completed ? authz.user.id : null, completed_at: parsed.data.completed ? now : null, updated_at: now } as never, { onConflict: "organization_id,processo_codigo,item_id" });
  if (error) return fail("internal_error", "Não foi possível atualizar o checklist.", 500, { requestId });
  await audit({ action: "contact.advomax_checklist_updated", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "advomax_document_checklist", resourceId: parsed.data.item_id, requestId, metadata: { contact_id: id, processo_codigo: parsed.data.processo_codigo, completed: parsed.data.completed } });
  return ok({ completed: parsed.data.completed, completed_at: parsed.data.completed ? now : null }, { requestId });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "advomax_document_checklist_template" });
  if (!authz.ok) return authz.response;
  const parsed = templateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Modelo de checklist inválido.", 422, { requestId });
  const { id } = await ctx.params;
  const scoped = await contexto(id, authz.org.orgId); if (scoped.error) return scoped.error;
  if (!(await processoValido(scoped.pessoaCodigo!, parsed.data.processo_codigo, parsed.data.tipo_acao_codigo, authz))) return fail("forbidden", "Processo não pertence à Pessoa vinculada.", 403, { requestId });
  const { data: existing } = await scoped.supabase.from("crm_document_checklist_templates" as never).select("id").eq("organization_id", authz.org.orgId).eq("advomax_tipo_acao_codigo", parsed.data.tipo_acao_codigo).maybeSingle();
  if (existing) return fail("conflict", "Já existe um modelo para este tipo de ação.", 409, { requestId });
  const { data: templateId, error } = await scoped.supabase.rpc("fn_create_checklist_template" as never, { p_org: authz.org.orgId, p_tipo_acao: parsed.data.tipo_acao_codigo, p_name: parsed.data.nome, p_items: parsed.data.itens } as never);
  if (error?.code === "23505") return fail("conflict", "Já existe um modelo para este tipo de ação.", 409, { requestId });
  if (error || typeof templateId !== "string") return fail("internal_error", "Não foi possível salvar o modelo.", 500, { requestId });
  await audit({ action: "contact.advomax_checklist_template_created", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "advomax_document_checklist_template", resourceId: templateId, requestId, metadata: { tipo_acao_codigo: parsed.data.tipo_acao_codigo, processo_codigo: parsed.data.processo_codigo, items: parsed.data.itens.length } });
  return ok({ id: templateId, items: parsed.data.itens.length }, { status: 201, requestId });
}
