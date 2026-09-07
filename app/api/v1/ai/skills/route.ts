/**
 * GET /api/v1/ai/skills
 *
 * Skills instaláveis (Fase 2 do épico harness — spec 2026-07-23). Devolve o estado
 * completo pra tela: `installed` (pointers da PRÓPRIA org, com a descrição da versão
 * ativa e `source` derivado de `forked_from_version_id` — 'catalog' quando veio de um
 * install do marketplace, 'manual' quando foi importada via .zip) e `catalog` (skills
 * de PLATAFORMA — organization_id null — que a org ainda NÃO instalou).
 *
 * Nota: isto é a lista do que a org geriu explicitamente, não a resolução completa do
 * runtime (`loadSkills`, que aplica skills de plataforma não-instaladas como fallback
 * global) — uma skill de catálogo já funciona pro agente antes de "instalada" aqui.
 *
 * organization_id vem SEMPRE de requireRole — nunca de query param.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface PointerRow {
  name: string;
  version_id: string;
}
interface OrgPointerRow extends PointerRow {
  updated_at: string;
}
interface VersionRow {
  id: string;
  description: string;
  forked_from_version_id: string | null;
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "ai_skills" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const admin = createAdminClient();

  const { data: orgPointers, error: orgErr } = await admin
    .from("skill_pointers")
    .select("name, version_id, updated_at")
    .eq("organization_id", org.orgId);
  if (orgErr) {
    return fail("internal_error", "Erro ao carregar skills instaladas.", 500, { requestId });
  }

  const { data: platformPointers, error: platErr } = await admin
    .from("skill_pointers")
    .select("name, version_id")
    .is("organization_id", null);
  if (platErr) {
    return fail("internal_error", t("Erro ao carregar catálogo de skills."), 500, { requestId });
  }

  const orgRows = (orgPointers ?? []) as OrgPointerRow[];
  const platformRows = (platformPointers ?? []) as PointerRow[];

  const versionIds = [...new Set([...orgRows, ...platformRows].map((p) => p.version_id))];
  let versions: VersionRow[] = [];
  if (versionIds.length > 0) {
    const { data: versionRows, error: verErr } = await admin
      .from("skill_versions")
      .select("id, description, forked_from_version_id")
      .in("id", versionIds);
    if (verErr) {
      return fail("internal_error", t("Erro ao carregar descrição das skills."), 500, { requestId });
    }
    versions = (versionRows ?? []) as VersionRow[];
  }
  const versionById = new Map(versions.map((v) => [v.id, v]));

  const installed = orgRows.map((p) => {
    const v = versionById.get(p.version_id);
    return {
      name: p.name,
      description: v?.description ?? "",
      version_id: p.version_id,
      source: (v?.forked_from_version_id ? "catalog" : "manual") as "catalog" | "manual",
      updated_at: p.updated_at,
    };
  });

  const installedNames = new Set(installed.map((i) => i.name));
  const catalog = platformRows
    .filter((p) => !installedNames.has(p.name))
    .map((p) => ({ name: p.name, description: versionById.get(p.version_id)?.description ?? "" }));

  return ok({ installed, catalog }, { requestId });
}
