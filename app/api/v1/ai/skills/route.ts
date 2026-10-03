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
import { compararSkill, type ComparativoEntrada } from "@/lib/ai/skills/comparativo";
import { temPonteiroCanonico } from "@/lib/ai/skills/ponteiro-canonico";
import { temVersaoNovaNoCatalogo } from "@/lib/ai/skills/versao-nova-catalogo";
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
  body: string;
  matcher: { any_keywords: string[]; probe_keywords?: string[] };
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

  const orgRows = (
    (orgPointers ?? []) as Array<
      Omit<OrgPointerRow, "name" | "version_id"> & {
        name: string | null;
        version_id: string | null;
      }
    >
  ).filter(temPonteiroCanonico);
  const platformRows = (
    (platformPointers ?? []) as Array<{ name: string | null; version_id: string | null }>
  ).filter(temPonteiroCanonico) as PointerRow[];

  const versionIds = [...new Set([...orgRows, ...platformRows].map((p) => p.version_id))];
  let versions: VersionRow[] = [];
  if (versionIds.length > 0) {
    const { data: versionRows, error: verErr } = await admin
      .from("skill_versions")
      .select("id, description, body, matcher, forked_from_version_id")
      .in("id", versionIds);
    if (verErr) {
      return fail("internal_error", t("Erro ao carregar descrição das skills."), 500, {
        requestId,
      });
    }
    versions = (versionRows ?? []) as VersionRow[];
  }
  const versionById = new Map(versions.map((v) => [v.id, v]));

  // Versão ATUAL de cada skill no catálogo de plataforma, por name. É o alvo do
  // aviso de versão nova: uma cópia da org estará desatualizada quando o
  // `forked_from_version_id` (a versão de plataforma de onde ela foi forked)
  // diferir da `version_id` que o ponteiro de plataforma aponta HOJE.
  const platformVersionByName = new Map(platformRows.map((p) => [p.name, p.version_id]));

  const installed = orgRows.map((p) => {
    const v = versionById.get(p.version_id);
    const forked = v?.forked_from_version_id;
    const plataforma = platformVersionByName.get(p.name);
    const versaoNova = temVersaoNovaNoCatalogo(forked, plataforma);
    // Comparativo (o que mudou) entre a cópia da org e a versão atual do catálogo,
    // para o operador decidir adotar (issue #1962). Só faz sentido quando o catálogo
    // publicou versão nova E as duas versões trazem corpo/matcher para comparar.
    const versaoCatalogo = plataforma ? versionById.get(plataforma) : undefined;
    let comparativo: ReturnType<typeof compararSkill> | null = null;
    if (versaoNova && v && versaoCatalogo && v.matcher && versaoCatalogo.matcher) {
      const orgEntrada: ComparativoEntrada = {
        description: v.description,
        body: v.body ?? "",
        matcher: v.matcher,
      };
      const catalogoEntrada: ComparativoEntrada = {
        description: versaoCatalogo.description,
        body: versaoCatalogo.body ?? "",
        matcher: versaoCatalogo.matcher,
      };
      comparativo = compararSkill(orgEntrada, catalogoEntrada);
    }
    return {
      name: p.name,
      description: v?.description ?? "",
      version_id: p.version_id,
      source: (forked ? "catalog" : "manual") as "catalog" | "manual",
      // Só faz sentido pra skill de catálogo: a cópia da org veio de um fork de uma
      // versão de plataforma; se o ponteiro de plataforma hoje aponta outra versão,
      // o catálogo publicou versão nova depois de instalada aqui. Manual nunca → false.
      versao_nova_catalogo: versaoNova,
      comparativo,
      updated_at: p.updated_at,
    };
  });

  const installedNames = new Set(installed.map((i) => i.name));
  const catalog = platformRows
    .filter((p) => !installedNames.has(p.name))
    .map((p) => ({ name: p.name, description: versionById.get(p.version_id)?.description ?? "" }));

  return ok({ installed, catalog }, { requestId });
}
