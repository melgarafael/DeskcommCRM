/**
 * GET|PATCH|DELETE /api/v1/ig-automation-flows/[id]
 *
 * Operações em um flow de automação do Instagram específico.
 *
 * GET    — detalhe do flow (viewer+)
 * PATCH  — atualizar parcialmente (manager+)
 * DELETE — desativar/deletar o flow (manager+)
 *
 * Segurança: filtramos `organization_id` do cookie/JWT — nunca do body.
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

// ── Validação ──────────────────────────────────────────────────────────────────

const TRIGGER_TIPOS = [
  "comment_keyword",
  "comment_no_post",
  "dm_keyword",
  "novo_seguidor",
  "story_reply",
  "novo_comentario",
] as const;

const ACAO_TIPOS = [
  "enviar_dm",
  "responder_comentario",
  "add_etiqueta",
  "criar_contato",
  "notificar_equipe",
  "add_funil_politico",
] as const;

const atualizarFlowSchema = z
  .object({
    nome: z.string().min(1).max(120),
    descricao: z.string().max(500).nullable(),
    ativo: z.boolean(),
    trigger_tipo: z.enum(TRIGGER_TIPOS),
    trigger_config: z
      .object({
        keywords: z.array(z.string()).optional(),
        case_sensitive: z.boolean().optional(),
        post_ids: z.array(z.string()).optional(),
        story_id: z.string().optional(),
      })
      .optional(),
    acoes: z
      .array(
        z.object({
          tipo: z.enum(ACAO_TIPOS),
          texto: z.string().optional(),
          etiqueta: z.string().optional(),
          pipeline_id: z.string().uuid().optional(),
          nivel: z.string().optional(),
          mensagem: z.string().optional(),
          assignee_user_id: z.string().uuid().optional(),
        }),
      )
      .min(1)
      .max(10)
      .optional(),
  })
  .partial(); // PATCH = todos opcionais

// ── Helpers ────────────────────────────────────────────────────────────────────

async function buscarFlow(db: ReturnType<typeof createAdminClient>, id: string, organizationId: string) {
  return db
    .from("ig_automation_flows")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();
}

// ── GET ────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "ig_automation_flows" });
  if (!authz.ok) return authz.response;

  const db = createAdminClient();
  const { data: flow, error } = await buscarFlow(db, id, authz.organizationId);

  if (error || !flow) {
    return fail("not_found", "Flow não encontrado", 404, { requestId });
  }

  return ok({ flow }, { headers: { "x-request-id": requestId } });
}

// ── PATCH ──────────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "ig_automation_flows" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "ig_automation_flows.update",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON inválido", 400, { requestId });
  }

  const parsed = atualizarFlowSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados inválidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  if (Object.keys(parsed.data).length === 0) {
    return fail("bad_request", "Nenhum campo para atualizar", 400, { requestId });
  }

  const db = createAdminClient();

  // Verificar existência + tenant
  const { data: existente, error: errBusca } = await buscarFlow(db, id, organizationId);
  if (errBusca || !existente) {
    return fail("not_found", "Flow não encontrado", 404, { requestId });
  }

  const { data: atualizado, error: errUpdate } = await db
    .from("ig_automation_flows")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (errUpdate) {
    return fail("internal_error", "Erro ao atualizar flow", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "ig_automation_flows.update",
    resource_id: id,
    metadata: { campos_alterados: Object.keys(parsed.data) },
  });

  return ok({ flow: atualizado }, { headers: { "x-request-id": requestId } });
}

// ── DELETE ─────────────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "ig_automation_flows" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "ig_automation_flows.delete",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  const db = createAdminClient();

  const { data: existente, error: errBusca } = await buscarFlow(db, id, organizationId);
  if (errBusca || !existente) {
    return fail("not_found", "Flow não encontrado", 404, { requestId });
  }

  // Soft-delete: desativa em vez de remover (preserva histórico de eventos)
  const { error: errDelete } = await db
    .from("ig_automation_flows")
    .update({ ativo: false })
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (errDelete) {
    return fail("internal_error", "Erro ao desativar flow", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "ig_automation_flows.delete",
    resource_id: id,
    metadata: { nome: existente.nome },
  });

  return ok({ deleted: true }, { headers: { "x-request-id": requestId } });
}
