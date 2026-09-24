import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/skills/[name]/restore
 *
 * Restaura uma versão ANTERIOR da skill: move o ponteiro da organização para
 * uma `skill_versions` já existente (Fase 5 do PLANO-CONFIG-UI-AGENTE). Não cria
 * versão nova — as versões são imutáveis; restaurar é apontar de volta.
 *
 * A versão só pode ser de uma skill com o MESMO nome e da MESMA organização
 * (fonte confiável: requireRole + checagem explícita). organization_id nunca vem
 * do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { setSkillPointer } from "@/lib/agent-engine/agent/skills";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const nameSchema = z.string().min(1).max(120);
const bodySchema = z.object({ version_id: z.string().uuid() }).strict();

export async function POST(
  req: NextRequest,
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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: versao } = await admin
    .from("skill_versions")
    .select("id")
    .eq("id", parsed.data.version_id)
    .eq("organization_id", org.orgId)
    .eq("name", name)
    .maybeSingle();
  if (!versao) {
    return fail("not_found", t("Versão não encontrada para esta skill."), 404, { requestId });
  }

  await setSkillPointer(getSkillsPool(), {
    tenantId: org.orgId,
    name,
    versionId: parsed.data.version_id,
  });

  await audit({
    action: "ai.skill_restored",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "skill_versions",
    resourceId: parsed.data.version_id,
    requestId,
    metadata: { name },
  });

  return ok({ name, version_id: parsed.data.version_id }, { requestId });
}
