/**
 * GET|PATCH|DELETE /api/v1/pol-leads/[id]
 *
 * Operacoes em um pol_lead especifico.
 *
 * GET    — detalhe do pol_lead com dados do contato (viewer+)
 * PATCH  — atualizar parcialmente (manager+)
 * DELETE — hard delete (admin only, dados de tenant)
 *
 * Seguranca: filtramos organization_id do cookie/JWT — nunca do body.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// -- Validacao ----------------------------------------------------------------

const SUPPORT_LEVELS = [
  "novo_cadastro",
  "simpatizante",
  "apoiador",
  "militante",
  "voto_certo",
] as const;

const TEMPERATURES = ["frio", "morno", "quente"] as const;

const atualizarPolLeadSchema = z
  .object({
    support_level: z.enum(SUPPORT_LEVELS),
    temperature: z.enum(TEMPERATURES),
    zona_eleitoral: z.string().max(20).nullable(),
    secao_eleitoral: z.string().max(20).nullable(),
    mobilizer_id: z.string().uuid().nullable(),
    leader_potential: z.boolean(),
    community_role: z.string().max(120).nullable(),
    territory_id: z.string().uuid().nullable(),
    consent_origin: z.string().max(120).nullable(),
    opt_out: z.boolean(),
  })
  .partial(); // PATCH = todos opcionais

// -- Helpers ------------------------------------------------------------------

async function buscarPolLead(db: ReturnType<typeof createAdminClient>, id: string, organizationId: string) {
  return db
    .from("pol_leads")
    .select("*, contacts(id, name, phone, email)")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();
}

// -- GET ----------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "pol_leads" });
  if (!authz.ok) return authz.response;

  const db = createAdminClient();
  const { data: polLead, error } = await buscarPolLead(db, id, authz.organizationId);

  if (error || !polLead) {
    return fail("not_found", "Pol_lead nao encontrado", 404, { requestId });
  }

  return ok({ pol_lead: polLead }, { headers: { "x-request-id": requestId } });
}

// -- PATCH --------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "pol_leads" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_leads.update",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = atualizarPolLeadSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  if (Object.keys(parsed.data).length === 0) {
    return fail("bad_request", "Nenhum campo para atualizar", 400, { requestId });
  }

  const db = createAdminClient();

  // Verificar existencia + tenant
  const { data: existente, error: errBusca } = await db
    .from("pol_leads")
    .select("id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Pol_lead nao encontrado", 404, { requestId });
  }

  const { data: atualizado, error: errUpdate } = await db
    .from("pol_leads")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (errUpdate) {
    return fail("internal_error", "Erro ao atualizar pol_lead", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_leads.update",
    resource_id: id,
    metadata: { campos_alterados: Object.keys(parsed.data) },
  });

  return ok({ pol_lead: atualizado }, { headers: { "x-request-id": requestId } });
}

// -- DELETE -------------------------------------------------------------------

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "pol_leads" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_leads.delete",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  const db = createAdminClient();

  const { data: existente, error: errBusca } = await db
    .from("pol_leads")
    .select("id, contact_id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Pol_lead nao encontrado", 404, { requestId });
  }

  // Hard delete — dados de tenant, nao audit
  const { error: errDelete } = await db
    .from("pol_leads")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (errDelete) {
    return fail("internal_error", "Erro ao deletar pol_lead", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_leads.delete",
    resource_id: id,
    metadata: { contact_id: existente.contact_id },
  });

  return ok({ deleted: true }, { headers: { "x-request-id": requestId } });
}
