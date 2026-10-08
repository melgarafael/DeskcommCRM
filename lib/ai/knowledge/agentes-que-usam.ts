/**
 * QUEM CONSULTA O ACERVO — a pergunta por trás do selo "Consultado por".
 *
 * ## Por que este arquivo existe (issue #2236)
 *
 * A tela do acervo embutia `ai_agent_versions` a partir de `ai_agents` sem
 * dica de FK. Existem DUAS: `ai_agent_versions_agent_id_fkey` (as versões do
 * agente) e `ai_agents_published_version_id_fkey` (a publicada). Com duas, o
 * PostgREST recusa o embed com PGRST201 ("more than one relationship was
 * found"), e como o `error` era descartado junto com o `data`, a página caía na
 * lista vazia e pintava "Consultado por: nenhum assistente ainda" para TODOS os
 * materiais — inclusive os que os agentes publicados leem em conversa real.
 *
 * Duas decisões moram aqui:
 *
 * 1. O embed NOMEIA a FK (`!ai_agents_published_version_id_fkey`) e lê direto a
 *    versão publicada: não há mais o que desambiguar, nem `published_version_id`
 *    para cruzar à mão com uma lista de versões.
 * 2. O `error` não é engolido. A degradação continua sendo lista vazia (a tela
 *    não pode quebrar), mas deixa rastro com a CAUSA em `logger.error`, com a
 *    organization_id que acampa a linha — sem isto, "não consegui perguntar" e
 *    "nenhum assistente usa isto" pintam a MESMA tela, e a segunda é uma
 *    afirmação forte sobre o trabalho de quem instalou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export interface AgenteQueUsa {
  id: string;
  nome: string;
  materiais: string[];
}

/**
 * `!ai_agents_published_version_id_fkey` não é enfeite: sem o nome da FK o
 * PostgREST responde PGRST201 e a tela inteira vira "nenhum assistente ainda".
 * A mesma dica já é o padrão em `app/app/ai/agents/page.tsx`.
 */
export const COLUNAS_AGENTES_QUE_USAM =
  "id, name, versao_publicada:ai_agent_versions!ai_agents_published_version_id_fkey(id, knowledge_source_ids)";

interface LinhaAgenteQueUsa {
  id: string;
  name: string;
  versao_publicada: { id: string; knowledge_source_ids: string[] | null } | null;
}

/**
 * Só quem TEM versão publicada com material entra: a tela usa esta lista para
 * responder "se eu arquivar este material, quem para de saber dele?" — agente
 * sem nada publicado não muda a resposta.
 */
export function montarAgentesQueUsam(linhas: LinhaAgenteQueUsa[]): AgenteQueUsa[] {
  return linhas
    .map((linha) => ({
      id: linha.id,
      nome: linha.name,
      materiais: linha.versao_publicada?.knowledge_source_ids ?? [],
    }))
    .filter((agente) => agente.materiais.length > 0);
}

export async function listarAgentesQueUsam(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ agentes: AgenteQueUsa[]; erro: string | null }> {
  const { data, error } = await supabase
    .from("ai_agents")
    .select(COLUNAS_AGENTES_QUE_USAM)
    .eq("organization_id", organizationId)
    .is("archived_at", null);

  if (error) {
    logger.error(
      "[ai/knowledge] não consegui listar quem consulta o acervo — o selo vai dizer 'nenhum assistente ainda'",
      {
        organization_id: organizationId,
        code: error.code ?? null,
        detail: error.message.slice(0, 200),
      },
    );
    return { agentes: [], erro: error.message };
  }

  return {
    agentes: montarAgentesQueUsam((data ?? []) as unknown as LinhaAgenteQueUsa[]),
    erro: null,
  };
}
