import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type NextRequest } from "next/server";
import { requireAgencia } from "@/lib/agencias/require-agencia";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const id = z
    .string()
    .uuid()
    .safeParse((await params).id);
  if (!id.success) return fail("validation_error", "Organização inválida.", 422, { requestId });
  const clienteId = id.data;
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const auth = await requireAgencia(requestId);
  if (!auth.ok) return auth.response;
  const { data, error } = await auth.db.rpc("fn_agencia_abrir_cliente", {
    p_agencia: auth.org.orgId,
    p_cliente: clienteId,
  });
  if (error)
    return fail(
      "forbidden",
      "Não foi possível abrir este cliente. Confira o vínculo, o estado e sua autorização.",
      403,
      { requestId },
    );
  await audit({
    action: "agency.session_started",
    actorUserId: auth.user.id,
    organizationId: clienteId,
    resourceType: "organization",
    resourceId: clienteId,
    requestId,
    metadata: { agency_id: auth.org.orgId, session_id: data },
  });
  return ok({ redirect_url: "/app/inbox" }, { requestId });
}
