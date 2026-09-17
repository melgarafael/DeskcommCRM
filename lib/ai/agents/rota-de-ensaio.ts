/**
 * Segmento HTTP do ensaio interno do agente.
 *
 * Não pode se chamar `test`: o App Router (Turbopack) não registra pasta com
 * esse nome — o POST caía em `app/not-found.tsx` (HTML) em vez do handler JSON.
 * `dry-run` casa com a coluna `is_dry_run` e com segmentos hífenados que o
 * Next já compilou (`tool-usage`).
 */
export const SEGMENTO_DE_ENSAIO = "dry-run" as const;

/**
 * O ensaio dispara o runtime real (e, na primeira vez em `next dev`, o
 * Turbopack ainda compila a rota). O `DEFAULT_TIMEOUT_MS` do apiClient (10s)
 * abortava o POST enquanto o servidor seguia — toast "Erro inesperado.", run
 * às vezes nem gravado. Só este POST espera 120s; o restante da API fica em 10s.
 */
export const TIMEOUT_MS_DO_ENSAIO = 120_000;

export function urlEnsaioDoAgente(agentId: string, versionId: string): string {
  return `/api/v1/ai/agents/${agentId}/versions/${versionId}/${SEGMENTO_DE_ENSAIO}`;
}
