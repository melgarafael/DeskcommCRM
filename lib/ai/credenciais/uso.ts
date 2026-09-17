/**
 * A REGRA de "esta credencial pode ser excluída?" — e o número que a explica.
 *
 * ─── Por que o número é TODO vínculo, e não só a versão publicada ───────────
 *
 * A FK `ai_agent_versions.credential_id` é `ON DELETE RESTRICT`: o BANCO recusa
 * a exclusão por causa de QUALQUER linha de `ai_agent_versions` que aponte para
 * a credencial — rascunho, superseded, arquivada, tanto faz. Enquanto a tela
 * contava só a versão PUBLICADA de agente não-arquivado, o operador via "Em uso
 * por 0" numa chave que o DELETE recusava, e o botão mentia duas vezes: dizia
 * que dava para excluir (o número) e, quando não dava, mandava "remover as
 * versões" (instrução que apaga o agente e que as FKs de `ai_agent_runs` e
 * `ai_reply_drafts` nem deixam seguir).
 *
 * O número honesto é, portanto, o mesmo que o banco enxerga: a contagem de
 * `ai_agent_versions` que referenciam a credencial. É ele que responde à
 * pergunta do botão — "o banco me deixa apagar isto?" —, e é ele que a tela
 * mostra. O caminho de saída não é apagar versão: é REPONTAR a versão para
 * outra credencial (o `AgentForm` já troca o `credential_id`).
 *
 * Consumida pela tela (`app/app/ai/credentials/page.tsx`) e pelo
 * `DELETE /api/v1/ai/credentials/:id`. Enquanto eram duas cópias, divergiram.
 */
export interface AgenteResumo {
  id: string;
  name: string;
  archived_at: string | null;
  published_version_id: string | null;
}

export interface VersaoVinculada {
  id: string;
  credential_id: string;
  /** Número da versão, para a mensagem dizer qual repontar. */
  version_number?: number | null;
  /** `draft` | `published` | `superseded` | `archived` — informativo na recusa. */
  status?: string | null;
  /**
   * O join com o agente. Opcional de propósito: CONTAR não precisa dele (só o
   * `credential_id` importa), e a tela busca o mínimo — quem precisa do nome é
   * a mensagem do DELETE, e é ele que pede o join.
   */
  ai_agents?: AgenteResumo | AgenteResumo[] | null;
}

/** O que trava a exclusão, em uma linha por versão — para a mensagem do DELETE. */
export interface VersaoQueBloqueia {
  versionId: string;
  versionNumber: number | null;
  status: string | null;
  agentName: string;
}

function agenteDe(linha: VersaoVinculada): AgenteResumo | null {
  if (Array.isArray(linha.ai_agents)) return linha.ai_agents[0] ?? null;
  return linha.ai_agents ?? null;
}

/**
 * Quantas versões de agente referenciam cada credencial. É exatamente o que a
 * FK `ON DELETE RESTRICT` considera — nada menos, nada mais.
 */
export function contarUsoQueBloqueia(linhas: VersaoVinculada[]): Record<string, number> {
  const mapa: Record<string, number> = {};
  for (const linha of linhas) {
    mapa[linha.credential_id] = (mapa[linha.credential_id] ?? 0) + 1;
  }
  return mapa;
}

/**
 * Quem trava, com nome e versão, para a recusa do DELETE dizer ONDE ir. O
 * operador precisa saber qual agente abrir e qual versão repontar — "há N
 * versões" sem nome é um beco com outro nome.
 */
export function versoesQueBloqueiam(
  linhas: VersaoVinculada[],
): Record<string, VersaoQueBloqueia[]> {
  const mapa: Record<string, VersaoQueBloqueia[]> = {};
  for (const linha of linhas) {
    const agente = agenteDe(linha);
    (mapa[linha.credential_id] ??= []).push({
      versionId: linha.id,
      versionNumber: linha.version_number ?? null,
      status: linha.status ?? null,
      agentName: agente?.name?.trim() || "",
    });
  }
  return mapa;
}
