import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { OrgMemoryState } from "@/hooks/ai/useOrgMemory";
import { traduzir } from "@/lib/i18n/dicionario";
import { supportWriteError } from "@/lib/impersonate/support";
import { dataIsoNoFuso } from "@/lib/propostas/data-no-fuso";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { limiteDoPesoDaMemoria } from "@/lib/schemas/settings";
import { OrgMemoryClient, type FalhasDeLeitura } from "./_client";

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

  // #4171 — as QUATRO leituras abaixo descartavam o `error` no destructuring:
  // com o banco fora do ar, a tela mostrava a mesma coisa que "não existe nada
  // publicado" ("Nenhuma versão publicada ainda"), escondendo memória que os
  // agentes seguiam usando. Cada falha agora vira estado próprio.
  const { data: pointer, error: erroDoPonteiro } = await supabase
    .from("org_memory_pointers")
    .select("version_id")
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  let document: OrgMemoryState["document"] = null;
  let erroDaVersaoApontada = false;
  if (pointer?.version_id) {
    const { data: ver, error: erroDaVersao } = await supabase
      .from("org_memory_versions")
      .select("id, version_number, content, created_at")
      .eq("id", pointer.version_id)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (erroDaVersao) {
      erroDaVersaoApontada = true;
    } else if (ver) {
      document = {
        version_id: ver.id,
        version_number: ver.version_number,
        content: ver.content,
        created_at: ver.created_at,
      };
    }
  }

  const { data: versionsRaw, error: erroDasVersoes } = await supabase
    .from("org_memory_versions")
    .select("id, version_number, created_at")
    .eq("organization_id", activeOrg.orgId)
    .order("version_number", { ascending: false });

  const { data: entriesRaw, error: erroDosAprendizados } = await supabase
    .from("org_memory_entries")
    .select("id, title, body, source, status, created_at, valid_until")
    .eq("organization_id", activeOrg.orgId)
    .neq("status", "proposed")
    .order("created_at", { ascending: false });

  const { data: org } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  // Sem ler o ponteiro não se sabe se há versão publicada: ilegível, não vazio.
  const falhasDeLeitura: FalhasDeLeitura = {
    documento: Boolean(erroDoPonteiro) || erroDaVersaoApontada,
    versoes: Boolean(erroDasVersoes),
    aprendizados: Boolean(erroDosAprendizados),
  };

  // O critério de `definirLimiteDoPesoDaMemoria`, que cobra de novo.
  const podeEditarOLimite = activeOrg.role === "admin" && supportWriteError(user.support) === null;

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
      <OrgMemoryClient
        initialState={initialState}
        falhasDeLeitura={falhasDeLeitura}
        hoje={dataIsoNoFuso(new Date(), fusoUtilizavel(activeOrg.timezone))}
        limiteDoAviso={limiteDoPesoDaMemoria(org?.settings)}
        podeEditarOLimite={podeEditarOLimite}
      />
    </div>
  );
}
