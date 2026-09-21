import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { listItems } from "@/lib/instagram/store";
import { editSchema } from "@/lib/instagram/schema";
const headers = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ id: string }> };
export async function GET(_req: Request, ctx: Context) {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success)
    return fail("invalid_request", "Criação inválida.", 400, { requestId });
  try {
    const items = await listItems(auth.org.orgId, id);
    return items[0]
      ? ok({ ...items[0], can_edit: auth.org.role !== "viewer" }, { requestId, headers })
      : fail("not_found", "Criação não encontrada.", 404, { requestId });
  } catch {
    return fail("instagram_unavailable", "Não foi possível abrir esta criação.", 503, {
      requestId,
    });
  }
}
export async function PATCH(req: Request, ctx: Context) {
  const requestId = randomUUID();
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const auth = await requireRole("agent", { requestId });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = editSchema.safeParse(await req.json().catch(() => null));
  if (!z.uuid().safeParse(id).success || !parsed.success)
    return fail("validation_failed", "Confira a legenda: no máximo 2.200 caracteres.", 400, {
      requestId,
    });
  try {
    const result = await getRequestPool().query(
      "update instagram_studio_items set caption=$3,updated_at=now() where organization_id=$1 and id=$2 and kind='post' returning id",
      [auth.org.orgId, id, parsed.data.caption],
    );
    if (!result.rowCount) return fail("not_found", "Criação não encontrada.", 404, { requestId });
    await audit({
      action: "instagram.caption_updated",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "instagram_studio_item",
      resourceId: id,
      requestId,
    });
    return ok({ saved: true }, { requestId, headers });
  } catch {
    return fail("instagram_unavailable", "A legenda não foi salva. Tente novamente.", 503, {
      requestId,
    });
  }
}
export async function DELETE(_req: Request, ctx: Context) {
  const requestId = randomUUID();
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const auth = await requireRole("agent", { requestId });
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success)
    return fail("invalid_request", "Referência inválida.", 400, { requestId });
  try {
    const result = await getRequestPool().query(
      "delete from instagram_studio_items where organization_id=$1 and id=$2 and kind='reference' returning id",
      [auth.org.orgId, id],
    );
    if (!result.rowCount)
      return fail("not_found", "Referência não encontrada.", 404, { requestId });
    await audit({
      action: "instagram.reference_removed",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "instagram_studio_item",
      resourceId: id,
      requestId,
    });
    return ok({ removed: true }, { requestId, headers });
  } catch {
    return fail("instagram_unavailable", "Não foi possível remover a referência.", 503, {
      requestId,
    });
  }
}
