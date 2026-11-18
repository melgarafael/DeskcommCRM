import { expect } from "@playwright/test";

import { TTL_CURTO_MS } from "../../../lib/auth/cache-curto";

/**
 * Espera uma escrita feita DIRETO no banco (service role, sem passar pelo app)
 * chegar à tela.
 *
 * O snapshot de autorização — vínculos, papel e os dados da empresa que viajam
 * com ele (país, idioma, fuso) — mora num cache de até `TTL_CURTO_MS` por
 * processo (#3696). O app invalida quando ELE grava; escrita de fora (psql,
 * worker, esta spec) espera a entrada vencer. É o contrato declarado, não um
 * atraso a esconder: a prova repete até a entrada vencer, com folga.
 */
export async function esperarEscritaDeFora(prova: () => Promise<void>): Promise<void> {
  await expect(prova).toPass({ timeout: TTL_CURTO_MS + 15_000, intervals: [1_000, 2_000, 5_000] });
}

/**
 * Para a LIMPEZA que desfaz, direto no banco, um dado que outra spec lê com a
 * mesma conta: sem esperar, a próxima spec herdaria por até `TTL_CURTO_MS` o
 * snapshot com o valor da limpeza ainda não visto.
 */
export async function esperarCacheCurtoVencer(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TTL_CURTO_MS + 1_000));
}
