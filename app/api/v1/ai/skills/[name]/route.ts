import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * DELETE /api/v1/ai/skills/[name]
 *
 * Desinstala uma skill da org: remove SÓ o `skill_pointers` da org pra esse name — a
 * skill some do agente (loadSkills não a resolve mais para este tenant). As
 * `skill_versions` NÃO são apagadas (histórico imutável — regra dura 9/CLAUDE.md);
 * reinstalar/reimportar cria versão nova.
 *
 * organization_id vem SEMPRE de requireRole — NUNCA de query/body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const nameSchema = z.string().min(1).max(120);

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ai_skills" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org } = authz;

  const { name: rawName } = await ctx.params;
  const nameParsed = nameSchema.safeParse(decodeURIComponent(rawName));
  if (!nameParsed.success) {
    return fail("validation_failed", t("Nome de skill inválido."), 422, { requestId });
  }
  const name = nameParsed.data;

  const admin = createAdminClient();
  const { data: deleted, error } = await admin
    .from("skill_pointers")
    .delete()
    .eq("organization_id", org.orgId)
    .eq("name", name)
    .select("name");

  if (error) {
    return fail("internal_error", "Erro ao desinstalar a skill.", 500, { requestId });
  }
  if (!deleted || deleted.length === 0) {
    return fail("not_found", t("Skill não está instalada nesta organização."), 404, { requestId });
  }

  await audit({
    action: "ai.skill_uninstalled",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "skill_pointers",
    // `resource_id` é UUID e `skill_pointers` não tem um: a chave é
    // (organization_id, name). Mandar o nome ali fazia o INSERT do audit estourar
    // com `invalid input syntax for type uuid` — e como audit é fire-and-forget
    // por doutrina, a desinstalação acontecia e a trilha ficava sem a linha,
    // silenciosamente, num DELETE. O nome identifica o recurso pelo metadata.
    resourceId: null,
    requestId,
    metadata: { name },
  });

  return ok({ name }, { requestId });
}
