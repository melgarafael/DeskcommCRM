import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type NextRequest } from "next/server";
import { configuracaoAgenciaSchema } from "@/lib/agencias/schema";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const id = z
    .string()
    .uuid()
    .safeParse((await params).id);
  const input = configuracaoAgenciaSchema.safeParse(await req.json().catch(() => null));
  if (!id.success || !input.success)
    return fail("validation_error", "Configuração de agência inválida.", 422, { requestId });
  const denied = await requireSupportWrite();
  if (denied) return denied;
  let ctx;
  try {
    ctx = await requirePlatformAdminEscrita();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId);
  }
  const db = createAdminClient();
  const { data: org, error: orgError } = await db
    .from("organizations")
    .select("id")
    .eq("id", id.data)
    .maybeSingle();
  if (orgError)
    return fail("internal_error", "Não foi possível consultar a organização.", 500, { requestId });
  if (!org) return fail("not_found", "Organização não encontrada.", 404, { requestId });
  const { error } = await db
    .from("agencia_configuracoes")
    .upsert({ organization_id: org.id, ...input.data }, { onConflict: "organization_id" });
  if (error)
    return fail(
      "conflict",
      "Não foi possível configurar a agência. Organizações clientes não podem administrar outras organizações.",
      409,
      { requestId },
    );
  await audit({
    action: "org.updated",
    actorUserId: ctx.user.id,
    organizationId: org.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "organization",
    resourceId: org.id,
    requestId,
    metadata: { agencia: input.data },
  });
  return ok(input.data, { requestId });
}
