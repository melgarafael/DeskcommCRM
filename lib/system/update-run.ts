/**
 * Vocabulário e transições de uma atualização disparada pela UI.
 *
 * Os valores de RunStatus e RunStep são os MESMOS do CHECK em
 * `system_update_runs` (migration 0089). O invariante
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` compara os dois —
 * mudar um lado sem o outro fica vermelho.
 */

export type RunStatus = "dispatched" | "success" | "failed" | "failed_rolled_back";
export type RunStep = "backup" | "codigo" | "banco";

/**
 * Depois disso sem notícia, a UI trata o run como desfecho desconhecido.
 * 15 min é folgado: uma atualização real leva ~2 min, e o agente ainda tenta
 * reportar por ~2 min após o reinício do app.
 */
export const RUN_STALE_AFTER_MS = 15 * 60 * 1000;

const TERMINAL: readonly RunStatus[] = ["success", "failed", "failed_rolled_back"];

/**
 * Só existe uma transição legítima: de `dispatched` para um desfecho. Um run
 * que já terminou é imutável — se o agente reportar duas vezes (retry após o
 * reinício do app), a segunda é recusada em vez de reescrever a história.
 */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return from === "dispatched" && TERMINAL.includes(to);
}

/**
 * `unknown` é DERIVADO na leitura, nunca gravado: um agente morto não consegue
 * anunciar a própria morte.
 */
export function isRunStale(dispatchedAt: string, now: Date): boolean {
  const started = Date.parse(dispatchedAt);
  if (Number.isNaN(started)) return true;
  return now.getTime() - started > RUN_STALE_AFTER_MS;
}

/**
 * O rollback deste run já foi superado por uma troca de app que não passou por
 * aqui?
 *
 * Sim quando o agente do host gravou `system_version` DEPOIS de o run terminar:
 * ele bateu no app que está no ar agora, e o run descreve um mundo anterior.
 * Falso sempre que falta uma das datas — ausência de prova não é prova de
 * deploy, e o run continua sendo a informação mais específica sobre o que subiu.
 */
export function rollbackFoiSuperado(
  versionUpdatedAt: string | null | undefined,
  runFinishedAt: string | null | undefined,
): boolean {
  if (!versionUpdatedAt || !runFinishedAt) return false;
  const gravado = Date.parse(versionUpdatedAt);
  const terminou = Date.parse(runFinishedAt);
  if (Number.isNaN(gravado) || Number.isNaN(terminou)) return false;
  return gravado > terminou;
}
