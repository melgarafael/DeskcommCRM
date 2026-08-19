/**
 * Que provedor/modelo a tela mostra para um agente — e de onde ele vem.
 *
 * Existe porque as duas respostas divergiam. `ai_agents.model` é escrito na
 * CRIAÇÃO e nunca mais (`${provider}/${model}` da v1); o motor lê
 * `ai_agent_versions.model` da versão PUBLICADA. Publicar uma v2 com outro
 * modelo deixava o card anunciando o da v1 — medido em produção com o card
 * dizendo "anthropic · claude-sonnet-5" e o agente rodando um nemotron grátis.
 *
 * Regra: a versão publicada VENCE, sempre. A coluna legada só responde por
 * quem não tem versão publicada — o `rag_bot` do editor antigo, e o `mcp_agent`
 * ainda em rascunho (que também não é atendido por ninguém).
 */

export interface AgenteComModelo {
  /** `ai_agents.model` — legado; para mcp_agent, foto do dia da criação. */
  model?: string | null;
  /** `ai_agent_versions.provider` da versão publicada (anexado pela listagem). */
  published_provider?: string | null;
  /** `ai_agent_versions.model` da versão publicada. */
  published_model?: string | null;
}

export interface ModeloExibido {
  provider: string;
  model: string;
  /** `versao` = o que o motor usa. `legado` = a coluna do agente (sem versão publicada). */
  origem: "versao" | "legado";
}

const VAZIO: ModeloExibido = { provider: "?", model: "—", origem: "legado" };

export function modeloExibido(agent: AgenteComModelo): ModeloExibido {
  const publicado = (agent.published_model ?? "").trim();
  if (publicado !== "") {
    return {
      // O provider é COLUNA na versão, então não se adivinha por prefixo: o id
      // da OpenRouter (`nvidia/nemotron…`) tem barra e não é o provedor dele.
      provider: (agent.published_provider ?? "").trim() || prefixo(publicado),
      model: publicado,
      origem: "versao",
    };
  }

  const legado = (agent.model ?? "").trim();
  if (legado === "") return VAZIO;
  return { provider: prefixo(legado), model: semPrefixo(legado), origem: "legado" };
}

function prefixo(id: string): string {
  return id.includes("/") ? (id.split("/")[0] ?? "?") : "?";
}

function semPrefixo(id: string): string {
  return id.includes("/") ? id.split("/").slice(1).join("/") : id;
}
