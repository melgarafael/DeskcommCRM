/**
 * POST /api/v1/fiscal-entradas/[id]/ignorar — a nota não é da operação.
 *
 * Desconhecimento honesto: em vez de deixar a linha pendente para sempre,
 * marca como ignorada (reversível só via banco — decisão consciente).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "fiscal-entradas" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const supabase = await createClient();
  const { data: linha } = await supabase
    .from("fiscal_entradas")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!linha) return fail("not_found", "Entrada não encontrada.", 404, { requestId });
  if ((linha as unknown as { status: string }).status === "importada") {
    return fail("invalid_state_transition", "Entrada já importada — não dá para ignorar.", 409, { requestId });
  }

  await supabase
    .from("fiscal_entradas")
    .update({ status: "ignorada" })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId);

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "fiscal_entrada.ignorada",
    resourceType: "fiscal_entradas",
    resourceId: id,
    requestId,
  });

  return ok({ ignorada: true }, { requestId });
}
