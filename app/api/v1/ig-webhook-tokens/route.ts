/**
 * GET|POST /api/v1/ig-webhook-tokens
 *
 * Gestão de tokens de webhook para o canal Instagram Graph API.
 *
 * GET  — lista tokens da organização (viewer+)
 * POST — gera novo token (manager+)
 *
 * Segurança: organization_id resolvido do cookie/JWT, nunca do body.
 * O path_token é gerado aqui com randomUUID — nunca aceito do cliente.
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

const criarTokenSchema = z.object({
  descricao: z.string().max(200).nullable().optional(),
  channel_session_id: z.string().uuid().optional(),
});

// ── GET ────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "ig_webhook_tokens" });
  if (!authz.ok) return authz.response;

  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("ig_webhook_tokens")
    .select("id, path_token, descricao, ativo, ultimo_ping_at, created_at, channel_session_id")
    .eq("organization_id", authz.organizationId)
    .order("created_at", { ascending: false });

  const ativoParam = params.get("ativo");
  if (ativoParam === "true") query = query.eq("ativo", true);
  if (ativoParam === "false") query = query.eq("ativo", false);

  const { data, error } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar tokens", 500, { requestId });
  }

  return ok({ tokens: data ?? [] }, { headers: { "x-request-id": requestId } });
}

// ── POST ───────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ig_webhook_tokens" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guarda = await requireSupportWrite({ requestId, resource: "ig_webhook_tokens.create" });
  if (!guarda.ok) return guarda.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON inválido", 400, { requestId });
  }

  const parsed = criarTokenSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados inválidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // path_token gerado aqui — nunca aceito do body
  const pathToken = randomUUID().replace(/-/g, "");

  const db = createAdminClient();
  const { data: token, error } = await db
    .from("ig_webhook_tokens")
    .insert({
      organization_id: organizationId,
      path_token: pathToken,
      descricao: parsed.data.descricao ?? null,
      channel_session_id: parsed.data.channel_session_id ?? null,
      ativo: true,
    })
    .select()
    .single();

  if (error) {
    return fail("internal_error", "Erro ao criar token", 500, { requestId });
  }

  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "ig_webhook_tokens.create",
    resource_id: token.id,
    metadata: { descricao: token.descricao },
  });

  return ok({ token }, { status: 201, headers: { "x-request-id": requestId } });
}
