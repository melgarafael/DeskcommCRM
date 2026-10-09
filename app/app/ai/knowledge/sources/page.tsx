import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { montarEstadoDaChave } from "@/lib/ai/embeddings/estado";
import { listarAgentesQueUsam } from "@/lib/ai/knowledge/agentes-que-usam";
import type { SourceRow } from "@/hooks/ai/useKnowledgeSources";
import { AcervoClient } from "./_client";

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

  const [{ data: sourcesRaw }, { agentes }, estadoDaChave] = await Promise.all([
    supabase
      .from("ai_knowledge_sources")
      .select("*")
      .eq("organization_id", activeOrg.orgId)
      .order("created_at", { ascending: false }),
    // Quem consulta o quê. A tela precisa disto para responder "se eu arquivar
    // este material, quem para de saber dele?" — sem essa resposta, arquivar é
    // um tiro no escuro. O embed nomeia a FK e o erro não é engolido; quem sabe
    // disto é `lib/ai/knowledge/agentes-que-usam.ts`.
    listarAgentesQueUsam(supabase, activeOrg.orgId),
    montarEstadoDaChave(supabase, activeOrg.orgId),
  ]);

  const initialSources = (sourcesRaw ?? []) as unknown as SourceRow[];

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
