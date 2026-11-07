import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { unidadeSchema } from "@/lib/avaliacao/schemas";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) return fail("not_found", "Not found", 404, { requestId });

  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "avaliacao_unidades" });
  if (!authz.ok) return authz.response;

  const body = unidadeSchema.partial().safeParse(await req.json().catch(() => ({})));
  if (!body.success || Object.keys(body.data).length === 0) {
    return fail("validation_failed", "Nenhum campo para atualizar.", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("avaliacao_unidades")
    .update({ ...body.data, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, name, sort_order, is_active")
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Unidade não encontrada.", 404, { requestId });

  void audit({
    action: "avaliacao.unidade_atualizada",
    resourceType: "avaliacao_unidade",
    resourceId: id,
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
  });

  return ok(data, { requestId });
}
