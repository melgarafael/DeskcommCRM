import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import {
  EXPLICACAO_DA_ORIGEM,
  resolverChaveDeEmbedding,
} from "@/lib/ai/embeddings/chave";
import type { EstadoDaChave } from "@/components/ai/ChaveDeConhecimento";
import type { SourceRow } from "@/hooks/ai/useKnowledgeSources";
import { AcervoClient, type AgenteQueUsa } from "./_client";

export const dynamic = "force-dynamic";

/**
 * O ACERVO DA ORGANIZAÇÃO.
 *
 * Esta página resolvia o agente com `.eq("is_default", true)` e mostrava quatro
 * cartões fixos, um por categoria. Como TODO agente criado pela interface nasce
 * `is_default: false`, só o agente semeado no bootstrap alcançava a tela — e
 * material de qualquer outro assistente era invisível aqui e no indexador.
 *
 * Desde a 0181 o acervo é da organização e cada assistente escolhe, na versão
 * publicada dele, o que consulta. Esta tela é a biblioteca; a escolha mora na
 * tela do agente.
 *
 * O estado da CHAVE vem do servidor junto com a lista, e não por fetch depois:
 * ele decide o que a tela pode prometer, e prometer primeiro para desmentir
 * depois é o defeito que esta página tinha.
 */
export default async function AcervoPage() {
  const user = await requireAuth();
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`).
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }


  const supabase = await createClient();

  const [{ data: sourcesRaw }, { data: agentesRaw }, chave, { data: credenciais }] =
    await Promise.all([
      supabase
        .from("ai_knowledge_sources")
        .select("*")
        .eq("organization_id", activeOrg.orgId)
        .order("created_at", { ascending: false }),
      // Quem consulta o quê. A tela precisa disto para responder "se eu arquivar
      // este material, quem para de saber dele?" — sem essa resposta, arquivar é
      // um tiro no escuro.
      supabase
        .from("ai_agents")
        .select("id, name, published_version_id, ai_agent_versions!inner(id, knowledge_source_ids)")
        .eq("organization_id", activeOrg.orgId)
        .is("archived_at", null),
      resolverChaveDeEmbedding(activeOrg.orgId),
      supabase
        .from("ai_provider_credentials_safe")
        .select("id, label, api_key_last4, validated_at, validation_error, is_active")
        .eq("organization_id", activeOrg.orgId)
        .eq("provider", "openai")
        .order("created_at", { ascending: true }),
    ]);

  const initialSources = (sourcesRaw ?? []) as unknown as SourceRow[];

  const agentes: AgenteQueUsa[] = ((agentesRaw ?? []) as unknown as Array<{
    id: string;
    name: string;
    published_version_id: string | null;
    ai_agent_versions: Array<{ id: string; knowledge_source_ids: string[] | null }>;
  }>)
    .map((a) => {
      const publicada = a.ai_agent_versions.find((v) => v.id === a.published_version_id);
      return {
        id: a.id,
        nome: a.name,
        materiais: publicada?.knowledge_source_ids ?? [],
      };
    })
    .filter((a) => a.materiais.length > 0);

  const estadoDaChave: EstadoDaChave = {
    pode_indexar: chave !== null,
    origem: chave?.origem ?? null,
    explicacao: chave ? EXPLICACAO_DA_ORIGEM[chave.origem] : null,
    chave_em_uso: chave?.rotulo ?? null,
    avisos: chave?.avisos ?? [],
    credenciais_openai: (credenciais ?? []) as EstadoDaChave["credenciais_openai"],
  };

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("O que o agente sabe")}</h1>
        <p className="text-sm text-text-muted">
          {t(
            "O material do seu negócio que os assistentes consultam antes de responder. Cada assistente escolhe, na tela dele, o que pode ler daqui.",
          )}
        </p>
      </header>

      <AcervoClient
        initialSources={initialSources}
        initialChave={estadoDaChave}
        agentes={agentes}
      />
    </div>
  );
}
