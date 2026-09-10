import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { carregarModulos } from "@/lib/modules/server";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
const inputSchema = z.object({ academia: z.boolean() }).strict();
export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "modules" });
  if (!auth.ok) return auth.response;
  try {
    return ok(await carregarModulos(auth.org.orgId), { requestId, headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail("internal_error", "Não foi possível carregar os módulos.", 500, { requestId });
  }
}
export async function PATCH(req: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "modules" });
  if (!auth.ok) return auth.response;
  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Escolha se o módulo deve ficar ativado ou desativado.", 422, { requestId });
  const { data, error } = await (await createClient()).rpc("fn_definir_modulo_academia", {
    p_org: auth.org.orgId, p_enabled: parsed.data.academia,
  });
  if (error) return fail(error.code === "42501" ? "forbidden" : "internal_error",
    "Não foi possível alterar o módulo. Confira sua permissão e tente novamente.", error.code === "42501" ? 403 : 500, { requestId });
  await audit({ action: "org.updated", actorUserId: auth.user.id, organizationId: auth.org.orgId,
    resourceType: "organization", resourceId: auth.org.orgId, requestId,
    metadata: { module: "academia", enabled: parsed.data.academia } });
  revalidatePath("/app", "layout");
  return ok({ academia: data === true }, { requestId });
}
