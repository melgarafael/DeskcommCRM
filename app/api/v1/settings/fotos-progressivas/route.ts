import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  fotosProgressivasConfig,
  mesclarFotosProgressivas,
} from "@/lib/catalogo/fotos-progressivas-config";

export const dynamic = "force-dynamic";
const schema = z.object({ habilitado: z.boolean() }).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_fotos_progressivas" });
  if (!auth.ok) return auth.response;
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("settings")
    .eq("id", auth.org.orgId)
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não consegui ler a configuração de fotos.", 500, { requestId });
  if (!data) return fail("not_found", "Empresa não encontrada.", 404, { requestId });
  return ok({ habilitado: fotosProgressivasConfig(data.settings) }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("manager", { requestId, resource: "settings_fotos_progressivas" });
  if (!auth.ok) return auth.response;
  const input = schema.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail("validation_error", "Informe somente habilitado como verdadeiro ou falso.", 422, {
      requestId,
    });
  const db = createAdminClient();
  const { data, error } = await db
    .from("organizations")
    .select("settings")
    .eq("id", auth.org.orgId)
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não consegui ler a configuração de fotos.", 500, { requestId });
  if (!data) return fail("not_found", "Empresa não encontrada.", 404, { requestId });
  const settings = mesclarFotosProgressivas(data.settings, input.data.habilitado);
  // Compare-and-set: não sobrescrever alterações concorrentes em outras configurações.
  let update = db.from("organizations").update({ settings }).eq("id", auth.org.orgId);
  update =
    data.settings === null
      ? update.is("settings", null)
      : update.eq("settings", JSON.stringify(data.settings));
  const result = await update.select("id").maybeSingle();
  if (result.error)
    return fail("internal_error", "Não consegui salvar a configuração de fotos.", 500, {
      requestId,
    });
  if (!result.data)
    return fail("conflict", "A configuração mudou. Recarregue a página antes de salvar.", 409, {
      requestId,
    });
  void audit({
    action: "catalogo.fotos_progressivas_changed",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "organization",
    resourceId: auth.org.orgId,
    requestId,
    metadata: { habilitado: input.data.habilitado },
  });
  return ok(input.data, { requestId });
}
