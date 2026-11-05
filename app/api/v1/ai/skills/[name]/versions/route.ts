/**
 * GET /api/v1/ai/skills/[name]/versions
 *
 * Histórico de versões da skill NESTA organização (Fase 5 do
 * PLANO-CONFIG-UI-AGENTE). Alimenta o seletor de rollback do editor: cada
 * `skill_versions` é imutável, então restaurar = mover o ponteiro para uma
 * versão antiga (não cria versão nova).
 *
 * Aceita sessão de navegador OU Bearer `dsk_…` com escopo `config:read`
 * e papel admin (`tokenRole`). A organização vem da linha do token, nunca de query.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { nomeDeSkillValido } from "@/lib/skills/nome-de-skill";

export const dynamic = "force-dynamic";

const nameSchema = z.string().min(1).max(120);

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_skills_versions",
    role: "agent",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const teto = await tetoDeEscritaDoToken(authz, "ai_skills_versions", requestId);
  if (teto) return teto;

  const { name: rawName } = await ctx.params;
  const nameParsed = nameSchema.safeParse(decodeURIComponent(rawName));
  if (!nameParsed.success || !nomeDeSkillValido(nameParsed.data)) {
    return fail("validation_failed", t("Nome de skill inválido."), 422, { requestId });
  }
  const name = nameParsed.data;

  const supabase = createAdminClient();
  const { data: pointer } = await supabase
    .from("skill_pointers")
    .select("version_id")
    .eq("organization_id", authz.organizationId)
    .eq("name", name)
    .maybeSingle();

  const { data: versions, error } = await supabase
    .from("skill_versions")
    .select("id, created_at, forked_from_version_id")
    .eq("organization_id", authz.organizationId)
    .eq("name", name)
    .order("created_at", { ascending: false });

  if (error) {
    return fail("internal_error", "Erro ao carregar o histórico da skill.", 500, { requestId });
  }

  const atualId = pointer?.version_id ?? null;
  return ok(
    {
      versions: (versions ?? []).map((v) => ({
        id: v.id,
        created_at: v.created_at,
        forked_from_version_id: v.forked_from_version_id,
        atual: v.id === atualId,
      })),
    },
    { requestId },
  );
}
