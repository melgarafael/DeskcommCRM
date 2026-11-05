import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/skills/[name]/restore
 *
 * Restaura uma versão ANTERIOR da skill: move o ponteiro da organização para
 * uma `skill_versions` já existente (Fase 5 do PLANO-CONFIG-UI-AGENTE). Não cria
 * versão nova — as versões são imutáveis; restaurar é apontar de volta.
 *
 * A versão só pode ser de uma skill com o MESMO nome e da MESMA organização
 * (fonte confiável: o portão — sessão ou linha do token — + checagem explícita).
 * organization_id nunca vem do body. Aceita sessão OU Bearer `dsk_…` (`config:write`,
 * papel admin via `tokenRole`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { setSkillPointer } from "@/lib/agent-engine/agent/skills";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { nomeDeSkillValido } from "@/lib/skills/nome-de-skill";

export const dynamic = "force-dynamic";

// Mesma classe da porta do proxy (`[name]` em portas-de-token/configuracao.ts): kebab-case.
const nameSchema = z.string().min(1).max(120);
const bodySchema = z.object({ version_id: z.string().uuid() }).strict();

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_skills",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const orgId = authz.organizationId;
  const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;
  const teto = await tetoDeEscritaDoToken(authz, "ai_skills", requestId);
  if (teto) return teto;

  const { name: rawName } = await ctx.params;
  const nameParsed = nameSchema.safeParse(decodeURIComponent(rawName));
  if (!nameParsed.success || !nomeDeSkillValido(nameParsed.data)) {
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
    .eq("organization_id", orgId)
    .eq("name", name)
    .maybeSingle();
  if (!versao) {
    return fail("not_found", t("Versão não encontrada para esta skill."), 404, { requestId });
  }

  await setSkillPointer(getSkillsPool(), {
    tenantId: orgId,
    name,
    versionId: parsed.data.version_id,
  });

  await audit({
    action: "ai.skill_restored",
    actorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: orgId,
    resourceType: "skill_versions",
    resourceId: parsed.data.version_id,
    requestId,
    metadata: { name },
  });

  return ok({ name, version_id: parsed.data.version_id }, { requestId });
}
