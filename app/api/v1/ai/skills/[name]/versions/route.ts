/**
 * GET /api/v1/ai/skills/[name]/versions
 *
 * Histórico de versões da skill NESTA organização (Fase 5 do
 * PLANO-CONFIG-UI-AGENTE). Alimenta o seletor de rollback do editor: cada
 * `skill_versions` é imutável, então restaurar = mover o ponteiro para uma
 * versão antiga (não cria versão nova).
 *
 * organization_id vem SEMPRE de requireRole — nunca de query.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const nameSchema = z.string().min(1).max(120);

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
  const { data: pointer } = await admin
    .from("skill_pointers")
    .select("version_id")
    .eq("organization_id", org.orgId)
    .eq("name", name)
    .maybeSingle();

  const { data: versions, error } = await admin
    .from("skill_versions")
    .select("id, created_at, forked_from_version_id")
    .eq("organization_id", org.orgId)
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
