import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SkillsState } from "@/hooks/ai/useSkills";
import { traduzir } from "@/lib/i18n/dicionario";
import { SkillsClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const admin = createAdminClient();

  const [{ data: orgPointers }, { data: platformPointers }] = await Promise.all([
    admin.from("skill_pointers").select("name, version_id, updated_at").eq("organization_id", activeOrg.orgId),
    admin.from("skill_pointers").select("name, version_id").is("organization_id", null),
  ]);

  const orgRows = orgPointers ?? [];
  const platformRows = platformPointers ?? [];
  const versionIds = [...new Set([...orgRows, ...platformRows].map((p) => p.version_id))];

  const { data: versionsRaw } =
    versionIds.length > 0
      ? await admin.from("skill_versions").select("id, description, forked_from_version_id").in("id", versionIds)
      : { data: [] };
  const versionById = new Map((versionsRaw ?? []).map((v) => [v.id, v]));

  const installed: SkillsState["installed"] = orgRows.map((p) => {
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
  const catalog: SkillsState["catalog"] = platformRows
    .filter((p) => !installedNames.has(p.name))
    .map((p) => ({ name: p.name, description: versionById.get(p.version_id)?.description ?? "" }));

  const initialState: SkillsState = { installed, catalog };
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Skills da IA", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Habilidades especializadas que seus agentes carregam só quando a conversa pede — instale prontas do catálogo ou envie a sua.",
            idioma,
          )}
        </p>
      </header>
      <SkillsClient initialState={initialState} />
    </div>
  );
}
