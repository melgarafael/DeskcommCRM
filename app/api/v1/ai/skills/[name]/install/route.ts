import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/skills/[name]/install
 *
 * Instala (fork-on-install) uma skill do catálogo de PLATAFORMA pro catálogo da org
 * (Task 4, `installPlatformSkill`) — a cópia da org fica independente dali em diante
 * (editar/desinstalar não afeta o catálogo de plataforma nem outras orgs).
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
import { getSkillsPool } from "@/lib/ai/skills/db";
import { installPlatformSkill } from "@/lib/ai/skills/install";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const nameSchema = z.string().min(1).max(120);

export async function POST(
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

  // Confere existência no catálogo ANTES de chamar installPlatformSkill — evita usar o
  // texto de um Error genérico como sinal de controle (installPlatformSkill lança a
  // mesma forma de erro pra "não encontrada" e pra falha de banco).
  const { data: platformSkill } = await admin
    .from("skill_pointers")
    .select("name")
    .is("organization_id", null)
    .eq("name", name)
    .maybeSingle();
  if (!platformSkill) {
    return fail("not_found", t("Skill não encontrada no catálogo de plataforma."), 404, { requestId });
  }

  const db = getSkillsPool();

  let result: { versionId: string };
  try {
    result = await installPlatformSkill({ db }, { organizationId: org.orgId, name, createdBy: authUser.id });
  } catch (err) {
    console.error("[skills-install] installPlatformSkill falhou:", err);
    return fail("internal_error", "Erro ao instalar a skill.", 500, { requestId });
  }

  await audit({
    action: "ai.skill_installed",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "skill_versions",
    resourceId: result.versionId,
    requestId,
    metadata: { name },
  });

  return ok({ version_id: result.versionId }, { status: 201, requestId });
}
