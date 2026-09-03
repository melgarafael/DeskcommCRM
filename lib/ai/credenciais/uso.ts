/**
 * A REGRA de "credencial em uso": referenciada pela versão PUBLICADA de um
 * agente não arquivado. Rascunho não conta (o operador pode trocar a chave do
 * rascunho antes de publicar); arquivado não conta.
 *
 * Consumida pela tela (`app/app/ai/credentials/page.tsx`) e pelo
 * `DELETE /api/v1/ai/credentials/:id`. Enquanto eram duas cópias, divergiram.
 */
export interface AgenteResumo {
  archived_at: string | null;
  published_version_id: string | null;
}

export interface VersaoVinculada {
  id: string;
  credential_id: string;
  /** O PostgREST devolve objeto ou array conforme a cardinalidade inferida. */
  ai_agents: AgenteResumo | AgenteResumo[] | null;
}

export function contarUsoPublicado(linhas: VersaoVinculada[]): Record<string, number> {
  const mapa: Record<string, number> = {};
  for (const linha of linhas) {
    const agente = Array.isArray(linha.ai_agents) ? linha.ai_agents[0] : linha.ai_agents;
    if (!agente || agente.archived_at) continue;
    if (agente.published_version_id !== linha.id) continue;
    mapa[linha.credential_id] = (mapa[linha.credential_id] ?? 0) + 1;
  }
  return mapa;
}
