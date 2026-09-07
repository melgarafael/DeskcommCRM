import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { OrgMemoryState } from "@/hooks/ai/useOrgMemory";
import { traduzir } from "@/lib/i18n/dicionario";
import { OrgMemoryClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function OrgMemoryPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;

  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();

  const { data: pointer } = await supabase
    .from("org_memory_pointers")
    .select("version_id")
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  let document: OrgMemoryState["document"] = null;
  if (pointer?.version_id) {
    const { data: ver } = await supabase
      .from("org_memory_versions")
      .select("id, version_number, content, created_at")
      .eq("id", pointer.version_id)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (ver) {
      document = {
        version_id: ver.id,
        version_number: ver.version_number,
        content: ver.content,
        created_at: ver.created_at,
      };
    }
  }

  const { data: versionsRaw } = await supabase
    .from("org_memory_versions")
    .select("id, version_number, created_at")
    .eq("organization_id", activeOrg.orgId)
    .order("version_number", { ascending: false });

  const { data: entriesRaw } = await supabase
    .from("org_memory_entries")
    .select("id, title, body, source, status, created_at")
    .eq("organization_id", activeOrg.orgId)
    .neq("status", "proposed")
    .order("created_at", { ascending: false });

  const initialState: OrgMemoryState = {
    document,
    versions: (versionsRaw ?? []) as unknown as OrgMemoryState["versions"],
    entries: (entriesRaw ?? []) as unknown as OrgMemoryState["entries"],
  };

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Memória da IA", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Regras e aprendizados que TODOS os agentes de IA desta organização seguem em qualquer conversa — não é uma configuração de um agente específico.",
            idioma,
          )}
        </p>
      </header>
      <OrgMemoryClient initialState={initialState} />
    </div>
  );
}
