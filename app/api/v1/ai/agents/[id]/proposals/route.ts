/**
 * Épico Operação Visível (F3) — GET: propostas do flywheel da org para a tela
 * do agente (pendentes e aplicadas; a UI mostra o diff e o botão de aplicar).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const querySchema = z.object({
  status: z.enum(["pending", "applied", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("agent", { requestId, resource: "flywheel_proposals" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { status, limit } = parsed.data;

  const admin = createAdminClient();
  // O agente existe nesta org? (as propostas são org-scoped; a tela é por agente)
  const { data: agent } = await admin
    .from("ai_agents")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!agent) {
    return fail("not_found", "Agente não encontrado nesta organização.", 404, { requestId });
  }

  let query = admin
    .from("flywheel_distiller_proposals")
    .select(
      "id, run_id, dataset, type, target, content, evidence, proposed_at, applied_at, applied_version_id, applied_by",
    )
    .eq("organization_id", org.orgId)
    .order("proposed_at", { ascending: false })
    .limit(limit);
  if (status === "pending") query = query.is("applied_at", null);
  if (status === "applied") query = query.not("applied_at", "is", null);

  const { data, error } = await query;
  if (error) {
    return fail("internal_error", "Falha ao carregar as propostas.", 500, { requestId });
  }
  return ok({ items: data ?? [] }, { requestId });
}
