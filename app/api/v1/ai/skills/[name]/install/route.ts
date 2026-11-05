import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/skills/[name]/install
 *
 * Instala (fork-on-install) uma skill do catálogo de PLATAFORMA pro catálogo da org
 * (Task 4, `installPlatformSkill`) — a cópia da org fica independente dali em diante
 * (editar/desinstalar não afeta o catálogo de plataforma nem outras orgs).
 *
 * Aceita sessão de navegador OU Bearer `dsk_…` (`config:write`, papel admin via `tokenRole`).
 * organization_id vem SEMPRE do portão (sessão ou linha do token) — NUNCA de query/body.
 * No token não há pessoa: `createdBy` é null.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { installPlatformSkill } from "@/lib/ai/skills/install";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { nomeDeSkillValido } from "@/lib/skills/nome-de-skill";

export const dynamic = "force-dynamic";

// Mesma classe da porta do proxy (`[name]` em portas-de-token/configuracao.ts): kebab-case.
const nameSchema = z.string().min(1).max(120);

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

  const admin = createAdminClient();

  // Cliente admin nos dois modos (sessão e token): a leitura do catálogo de PLATAFORMA
  // (`organization_id is null`, abaixo) é intencional e vale para toda organização; o
  // que se grava (installPlatformSkill) leva SEMPRE a organização do portão.
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
    result = await installPlatformSkill({ db }, { organizationId: orgId, name, createdBy: actorUserId });
  } catch (err) {
    console.error("[skills-install] installPlatformSkill falhou:", err);
    return fail("internal_error", "Erro ao instalar a skill.", 500, { requestId });
  }

  await audit({
    action: "ai.skill_installed",
    actorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: orgId,
    resourceType: "skill_versions",
    resourceId: result.versionId,
    requestId,
    metadata: { name },
  });

  return ok({ version_id: result.versionId }, { status: 201, requestId });
}
