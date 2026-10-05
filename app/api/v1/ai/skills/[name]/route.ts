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
 * (nunca edita a antiga — imutabilidade) e move o ponteiro da org. Só edita skill
 * já instalada na org (criar é pelo .zip) e separa o que é EDITÁVEL do que é
 * ESTRUTURAL: descrição/matcher/body passam aqui, arquivo não (schema `.strict()` —
 * 422, a estrutura só muda por novo .zip). Skill de pacote com `references/`/
 * `assets/` também salva (#2047): a versão nova herda o manifesto e os objetos
 * são copiados pro prefixo dela (lib/ai/skills/package-files.ts) ANTES do ponteiro
 * mover — falha na cópia = 500 e nada muda na tela do agente.
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
  validateSkillBody,
} from "@/lib/agent-engine/agent/skills";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { caminhosDoManifesto, copiarArquivosDoPacote } from "@/lib/ai/skills/package-files";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const nameSchema = z.string().min(1).max(120);

const salvarSkillSchema = z
  .object({
    // Uma linha só, como no import: a descrição entra no índice de skills do
    // prefixo do turno, e uma quebra de linha ali monta cabeçalho falso.
    description: z.string().trim().min(1).max(500).regex(/^[^\r\n]*$/),
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
    .select("id, name, description, body, matcher, manifest")
    .eq("id", pointer.version_id)
    .maybeSingle();
  if (verErr) {
    return fail("internal_error", "Erro ao carregar o corpo da skill.", 500, { requestId });
  }
  if (!version) {
    return fail("not_found", t("Versão da skill não encontrada."), 404, { requestId });
  }

  const arquivosDoPacote = caminhosDoManifesto(
    Array.isArray(version.manifest) ? version.manifest : [],
  );

  return ok(
    {
      name: version.name,
      description: version.description,
      body: version.body,
      matcher: version.matcher,
      version_id: version.id,
      updated_at: pointer.updated_at,
      // Skill de pacote: o texto É editável (o PUT herda manifesto + arquivos na
      // versão nova) e a tela mostra o que é estrutural — mudar arquivo é por
      // novo .zip (#2047).
      tem_arquivos_do_pacote: arquivosDoPacote.length > 0,
      arquivos_do_pacote: arquivosDoPacote,
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

  // O editor só edita skill JÁ instalada nesta organização. Criar skill nova é o
  // caminho do .zip, que valida o nome contra o alfabeto do Storage.
  const admin = createAdminClient();
  const { data: pointer, error: ptrErr } = await admin
    .from("skill_pointers")
    .select("version_id")
    .eq("organization_id", org.orgId)
    .eq("name", name)
    .maybeSingle();
  if (ptrErr) {
    logger.error("ai.skills.put: falha ao ler o ponteiro", { requestId, error: ptrErr.message });
    return fail("internal_error", "Erro ao carregar a skill.", 500, { requestId });
  }
  if (!pointer) {
    return fail("not_found", t("Skill não está instalada nesta organização."), 404, { requestId });
  }
  // `forked_from_version_id` desce junto: a cópia editada continua sendo cópia da
  // MESMA versão de plataforma (não vira manual), senão o aviso de versão nova
  // some no 1º edit — `temVersaoNovaNoCatalogo` precisa do vínculo pra comparar.
  const { data: atual, error: verErr } = await admin
    .from("skill_versions")
    .select("manifest, forked_from_version_id")
    .eq("id", pointer.version_id)
    .maybeSingle();
  if (verErr) {
    logger.error("ai.skills.put: falha ao ler a versão atual", { requestId, error: verErr.message });
    return fail("internal_error", "Erro ao carregar a skill.", 500, { requestId });
  }
  // Os arquivos do pacote moram no Storage sob o id da VERSÃO
  // (`skill-references.ts`). Uma versão nova nasce sem eles — por isso a edição
  // textual de skill de pacote HERDA o manifesto aqui e copia os objetos pro
  // prefixo novo antes de mover o ponteiro (lib/ai/skills/package-files.ts).
  // Falha na cópia => 500 sem mover nada: o agente segue lendo a versão antiga,
  // intacta. O que NÃO passa por este PUT é a estrutura: o schema é `.strict()`,
  // então `manifest`/`files` no body dão 422 — mudar arquivo é por novo .zip.
  const manifestAtual = Array.isArray(atual?.manifest) ? atual.manifest : [];

  // Validação ANTES do banco: erro de conteúdo é 422 com a mensagem que ensina;
  // erro de banco é 500, sem vazar a mensagem do driver.
  try {
    validateSkillBody(parsed.data.body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail("validation_failed", msg.slice(0, 300), 422, { requestId });
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
      // Herança: a versão editada mantém os arquivos do pacote e o vínculo com
      // o catálogo da cópia anterior (uma cópia editada continua devedora da
      // MESMA versão de plataforma, então o aviso de versão nova segue valendo
      // após o 1º edit — antes virava manual e nunca mais avisava).
      manifest: manifestAtual,
      forkedFromVersionId: atual?.forked_from_version_id ?? null,
    });
    if (manifestAtual.length > 0) {
      try {
        await copiarArquivosDoPacote(
          { admin },
          {
            organizationId: org.orgId,
            name,
            deVersionId: pointer.version_id,
            paraVersionId: version.id,
            manifest: manifestAtual,
          },
        );
      } catch (err) {
        logger.error("ai.skills.put: falha ao herdar os arquivos do pacote", {
          requestId,
          deVersionId: pointer.version_id,
          paraVersionId: version.id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Versão órfã no banco (nenhum ponteiro aponta pra ela) e os arquivos
        // já copiados foram removidos pela própria cópia — a tela do agente
        // continua na versão antiga, com as references inteiras.
        return fail(
          "internal_error",
          t("Não foi possível copiar os arquivos do pacote para a versão nova. Nada mudou — tente de novo."),
          500,
          { requestId },
        );
      }
    }
    await setSkillPointer(pool, { tenantId: org.orgId, name, versionId: version.id });
    versionId = version.id;
  } catch (err) {
    logger.error("ai.skills.put: falha ao gravar a versão", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Erro ao salvar a skill.", 500, { requestId });
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
