import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { OrgMemoryState } from "@/hooks/ai/useOrgMemory";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { supportWriteError } from "@/lib/impersonate/support";
import { dataIsoNoFuso } from "@/lib/propostas/data-no-fuso";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { limiteDoPesoDaMemoria } from "@/lib/schemas/settings";
import { OrgMemoryClient } from "./_client";
import type { CampoDaMemoria } from "./leitura";

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

  /**
   * O QUE NÃO DEU PARA LER (#4171).
   *
   * Cada leitura da memória tem `error` próprio, e antes nenhum deles era lido:
   * policy negando o select, coluna ausente (`valid_until`, migration 0790) ou
   * timeout viravam `null`/`[]`, e a tela dizia "Nenhuma versão publicada
   * ainda" / "Nenhum aprendizado ainda" sobre uma memória que está lá e que os
   * agentes seguem usando (eles leem pelo pool do servidor, não por aqui).
   * Afirmar "vazio" sem ter conseguido perguntar é o defeito; o rastro fica no
   * log e a tela recebe a lista do que ela NÃO pode afirmar.
   */
  const camposNaoLidos: CampoDaMemoria[] = [];
  const naoLido = (campo: CampoDaMemoria) => {
    if (!camposNaoLidos.includes(campo)) camposNaoLidos.push(campo);
  };

  const { data: pointer, error: pointerErro } = await supabase
    .from("org_memory_pointers")
    .select("version_id")
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (pointerErro) naoLido("documento");

  let document: OrgMemoryState["document"] = null;
  if (pointer?.version_id) {
    const { data: ver, error: versaoErro } = await supabase
      .from("org_memory_versions")
      .select("id, version_number, content, created_at")
      .eq("id", pointer.version_id)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    // Ponteiro existe e a versão não pôde ser lida: há versão publicada, e a
    // tela não sabe QUAL. Isso é "não li", nunca "nenhuma versão publicada".
    if (versaoErro) naoLido("documento");
    if (ver && !versaoErro) {
      document = {
        version_id: ver.id,
        version_number: ver.version_number,
        content: ver.content,
        created_at: ver.created_at,
      };
    }
  }

  const { data: versionsRaw, error: versoesErro } = await supabase
    .from("org_memory_versions")
    .select("id, version_number, created_at")
    .eq("organization_id", activeOrg.orgId)
    .order("version_number", { ascending: false });
  if (versoesErro) naoLido("historico");

  const { data: entriesRaw, error: entradasErro } = await supabase
    .from("org_memory_entries")
    .select("id, title, body, source, status, created_at, valid_until")
    .eq("organization_id", activeOrg.orgId)
    .neq("status", "proposed")
    .order("created_at", { ascending: false });
  if (entradasErro) naoLido("aprendizados");

  if (camposNaoLidos.length > 0) {
    logger.error("[ai/memory] não consegui ler parte da memória — a tela avisa em vez de dizer vazia", {
      organization_id: activeOrg.orgId,
      campos: camposNaoLidos,
      detalhe: [pointerErro, versoesErro, entradasErro]
        .map((e) => e?.message?.slice(0, 200))
        .filter(Boolean),
    });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

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
        orgId={activeOrg.orgId}
        initialState={initialState}
        camposNaoLidos={camposNaoLidos}
        hoje={dataIsoNoFuso(new Date(), fusoUtilizavel(activeOrg.timezone))}
        limiteDoAviso={limiteDoPesoDaMemoria(org?.settings)}
        podeEditarOLimite={podeEditarOLimite}
      />
    </div>
  );
}
