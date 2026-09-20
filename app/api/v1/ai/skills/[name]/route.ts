import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/ai/skills/[name]  — lê o corpo/matcher da skill instalada (editor)
 * PUT    /api/v1/ai/skills/[name]  — salva nova versão do corpo + move o ponteiro
 * DELETE /api/v1/ai/skills/[name]
 *
 * DELETE desinstala uma skill da org: remove SÓ o `skill_pointers` da org pra esse name — a
 * skill some do agente (loadSkills não a resolve mais para este tenant). As
 * `skill_versions` NÃO são apagadas (histórico imutável — regra dura 9/CLAUDE.md);
 * reinstalar/reimportar cria versão nova.
 *
 * PUT é o editor da tela (Fase 2 do PLANO-CONFIG-UI-AGENTE): cria uma versão NOVA
 * (nunca edita a antiga — imutabilidade) e move o ponteiro da org. Se a skill ainda
 * não existia para a org, cria; se existia, publica por cima. Semântica de
 * versionamento igual à do import/install.
 *
 * organization_id vem SEMPRE de requireRole — NUNCA de query/body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  insertSkillVersion,
  setSkillPointer,
  skillMatcherSchema,
} from "@/lib/agent-engine/agent/skills";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const nameSchema = z.string().min(1).max(120);

const salvarSkillSchema = z
  .object({
    description: z.string().trim().min(1).max(500),
    body: z.string().min(1).max(60_000),
    matcher: skillMatcherSchema,
  })
  .strict();

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "ai_skills" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const { name: rawName } = await ctx.params;
  const nameParsed = nameSchema.safeParse(decodeURIComponent(rawName));
  if (!nameParsed.success) {
    return fail("validation_failed", t("Nome de skill inválido."), 422, { requestId });
  }
  const name = nameParsed.data;

  const admin = createAdminClient();
  const { data: pointer, error: ptrErr } = await admin
    .from("skill_pointers")
    .select("version_id, updated_at")
    .eq("organization_id", org.orgId)
    .eq("name", name)
    .maybeSingle();
  if (ptrErr) {
    return fail("internal_error", "Erro ao carregar a skill.", 500, { requestId });
  }
  if (!pointer) {
    return fail("not_found", t("Skill não está instalada nesta organização."), 404, { requestId });
  }

  const { data: version, error: verErr } = await admin
    .from("skill_versions")
    .select("id, name, description, body, matcher")
    .eq("id", pointer.version_id)
    .maybeSingle();
  if (verErr) {
    return fail("internal_error", "Erro ao carregar o corpo da skill.", 500, { requestId });
  }
  if (!version) {
    return fail("not_found", t("Versão da skill não encontrada."), 404, { requestId });
  }

  return ok(
    {
      name: version.name,
      description: version.description,
      body: version.body,
      matcher: version.matcher,
      version_id: version.id,
      updated_at: pointer.updated_at,
    },
    { requestId },
  );
}

export async function PUT(
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
  const parsed = salvarSkillSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const pool = getSkillsPool();
  let versionId: string;
  try {
    const version = await insertSkillVersion(pool, {
      tenantId: org.orgId,
      name,
      description: parsed.data.description,
      body: parsed.data.body,
      matcher: parsed.data.matcher,
    });
    await setSkillPointer(pool, { tenantId: org.orgId, name, versionId: version.id });
    versionId = version.id;
  } catch (err) {
    // `insertSkillVersion` valida o teto de 200 linhas e o matcher; a mensagem é
    // instrutiva (diz o que corrigir) e vira 422 em vez de 500.
    const msg = err instanceof Error ? err.message : String(err);
    return fail("validation_failed", msg.slice(0, 300), 422, { requestId });
  }

  await audit({
    action: "ai.skill_saved",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "skill_versions",
    // `resource_id` é UUID: aqui a versão TEM id, então vai.
    resourceId: versionId,
    requestId,
    metadata: { name, keywords: parsed.data.matcher.any_keywords.length },
  });

  return ok({ name, version_id: versionId }, { requestId });
}

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
