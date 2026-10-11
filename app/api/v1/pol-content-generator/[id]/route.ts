/**
 * GET|PATCH|DELETE /api/v1/pol-content-generator/[id]
 *
 * Operacoes em um conteudo gerado especifico.
 *
 * GET    — detalhe do conteudo (viewer+)
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

const PLATFORMS = [
  "instagram",
  "facebook",
  "twitter",
  "tiktok",
  "youtube",
  "linkedin",
  "whatsapp",
  "news",
  "cross_platform",
] as const;

const CONTENT_TYPES = [
  "video_script",
  "caption",
  "carousel",
  "story",
  "reel_script",
  "live_script",
  "article",
  "thread",
  "other",
] as const;

const GENERATION_SOURCES = [
  "manual",
  "ai_auto",
  "ai_assisted",
  "template",
] as const;

const atualizarConteudoSchema = z
  .object({
    title: z.string().min(1).max(500),
    topic: z.string().min(1).max(500),
    target_audience: z.string().max(500).nullable(),
    content_type: z.enum(CONTENT_TYPES),
    script: z.string().max(10000).nullable(),
    caption: z.string().max(5000).nullable(),
    hashtags: z.array(z.string().max(100)).nullable(),
    cta: z.string().max(500).nullable(),
    platform: z.enum(PLATFORMS).nullable(),
    viral_score: z.number().min(0).max(100).nullable(),
    quality_score: z.number().min(0).max(100).nullable(),
    generation_source: z.enum(GENERATION_SOURCES),
  })
  .partial(); // PATCH = todos opcionais

// -- Helpers ------------------------------------------------------------------

async function buscarConteudo(db: ReturnType<typeof createAdminClient>, id: string, organizationId: string) {
  return db
    .from("pol_generated_content")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();
}

// -- GET ----------------------------------------------------------------------

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "pol_generated_content" });
  if (!authz.ok) return authz.response;

  const db = createAdminClient();
  const { data: conteudo, error } = await buscarConteudo(db, id, authz.organizationId);

  if (error || !conteudo) {
    return fail("not_found", "Conteudo nao encontrado", 404, { requestId });
  }

  return ok({ pol_generated_content: conteudo }, { headers: { "x-request-id": requestId } });
}

// -- PATCH --------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "pol_generated_content" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_generated_content.update",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = atualizarConteudoSchema.safeParse(body);
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
    .from("pol_generated_content")
    .select("id")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Conteudo nao encontrado", 404, { requestId });
  }

  const { data: atualizado, error: errUpdate } = await db
    .from("pol_generated_content")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (errUpdate) {
    return fail("internal_error", "Erro ao atualizar conteudo", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_generated_content.update",
    resource_id: id,
    metadata: { campos_alterados: Object.keys(parsed.data) },
  });

  return ok({ pol_generated_content: atualizado }, { headers: { "x-request-id": requestId } });
}

// -- DELETE -------------------------------------------------------------------

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "pol_generated_content" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_generated_content.delete",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  const db = createAdminClient();

  const { data: existente, error: errBusca } = await db
    .from("pol_generated_content")
    .select("id, title")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !existente) {
    return fail("not_found", "Conteudo nao encontrado", 404, { requestId });
  }

  const { error: errDelete } = await db
    .from("pol_generated_content")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (errDelete) {
    return fail("internal_error", "Erro ao deletar conteudo", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_generated_content.delete",
    resource_id: id,
    metadata: { title: existente.title },
  });

  return ok({ deleted: true }, { headers: { "x-request-id": requestId } });
}
