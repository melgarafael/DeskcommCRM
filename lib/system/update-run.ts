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
 * ## As duas situações, que o tempo sozinho NÃO separa
 *
 * **(a) Logo depois do rollback.** O agente do host roda `git describe` DEPOIS
 * do checkout, então ele reporta a versão NOVA — a que acabou de quebrar. Essa
 * batida chega segundos depois de o run terminar, e é a mentira que o run
 * existe para desfazer. Aqui o run tem de vencer.
 *
 * **(b) Oito dias e vários deploys depois.** O app trocou de versão por
 * caminhos que não criam run (`docker compose up -d`, deploy por CI,
 * `update.sh` no terminal). O run virou notícia velha e seguia nomeando a
 * versão no ar — medido em produção: o rodapé anunciou por oito dias uma versão
 * de 28 de agosto. Aqui o host tem de vencer.
 *
 * Nos DOIS o host reporta depois do run. A primeira versão desta função
 * comparava só as datas, e por isso consertava (b) quebrando (a) — pego pela
 * `tests/e2e/system-update.spec.ts`, que percorre exatamente o cenário (a).
 *
 * ## O que separa: a versão reportada, não o relógio
 *
 * Em (a) o host reporta `run.to_version` — a que o checkout instalou e que o
 * contêiner recusou. Em (b) ele reporta o que um outro caminho subiu, que é
 * outra coisa. Então o run só é superado quando o host reporta uma versão que
 * **o run não descreve** — nem a que tentou instalar, nem a que restaurou.
 *
 * O caso que fica de fora é reinstalar À MÃO exatamente a versão que falhou e
 * dessa vez funcionar: ali o rodapé segue nomeando a anterior. Falha
 * conservadora e de propósito — ela empurra para atualizar, enquanto o erro
 * oposto seria anunciar como no ar justamente a versão que quebrou.
 *
 * Falso sempre que falta uma das datas — ausência de prova não é prova de
 * deploy, e o run continua sendo a informação mais específica sobre o que subiu.
 */
export function rollbackFoiSuperado(
  versionUpdatedAt: string | null | undefined,
  runFinishedAt: string | null | undefined,
  versaoReportadaPeloHost?: string | null | undefined,
  run?: { from_version?: string | null; to_version?: string | null } | null,
): boolean {
  if (!versionUpdatedAt || !runFinishedAt) return false;
  const gravado = Date.parse(versionUpdatedAt);
  const terminou = Date.parse(runFinishedAt);
  if (Number.isNaN(gravado) || Number.isNaN(terminou)) return false;
  if (gravado <= terminou) return false;

  // Sem saber o que o host reportou, fica valendo o run: é o degrau
  // conservador, e é o comportamento de antes desta função existir.
  if (!versaoReportadaPeloHost) return false;
  const descritasPeloRun = [run?.to_version, run?.from_version].filter(Boolean);
  return !descritasPeloRun.includes(versaoReportadaPeloHost);
}

/**
 * O run terminou BEM e o host ainda não teve chance de contar?
 *
 * ## O silêncio de até 5 minutos depois de dar certo
 *
 * `run_result` com `status: "success"` escreve só em `system_update_runs` — ele
 * **não toca** `system_version.current_version`. Quem escreve essa coluna é o
 * heartbeat do `agent.sh`, e ele roda de 5 em 5 minutos — o cabeçalho do
 * próprio `agent.sh` diz "a cada 5 minutos", e a linha de cron que o instalador
 * escreve está em `hostgator-setup-kit/test-validators.sh`.
 *
 * Então, na janela entre o fim da atualização e a batida seguinte,
 * `current_version` ainda nomeia a versão ANTIGA — e `update_available`
 * (`latest !== current`) continua verdadeiro. A tela volta do reinício
 * oferecendo o botão "Atualizar agora" para a versão que **acabou de ser
 * instalada**. Quem clicou faz tudo de novo, ou conclui que não funcionou.
 *
 * ## Por que assumir o `to_version` é seguro aqui
 *
 * `success` é o agente do host dizendo que o `update.sh` foi até o fim — a
 * troca de imagem incluída. Diferente do caso de rollback (onde o host reporta
 * a versão que QUEBROU e o run precisa contradizê-lo), aqui os dois concordam;
 * o host só ainda não falou.
 *
 * E é auto-corrigível por construção: assim que a batida chega,
 * `system_version.updated_at` passa a ser posterior ao `finished_at` e esta
 * função devolve `false` — o host volta a mandar, sem exceção nenhuma. É o
 * mesmo desempate temporal de `rollbackFoiSuperado`, na direção contrária.
 *
 * Sem `finished_at` (run antigo, agente velho) devolve `false`: sem a data não
 * há como saber se o host já falou depois, e o degrau conservador é o de antes.
 * Sem `versionUpdatedAt` devolve `true` — o host nunca reportou coisa alguma, e
 * o run é a única notícia que existe.
 */
export function sucessoJaInstalado(
  versionUpdatedAt: string | null | undefined,
  runFinishedAt: string | null | undefined,
  run?: { status?: string | null; to_version?: string | null } | null,
): boolean {
  if (run?.status !== "success" || !run.to_version) return false;
  if (!runFinishedAt) return false;
  const terminou = Date.parse(runFinishedAt);
  if (Number.isNaN(terminou)) return false;
  if (!versionUpdatedAt) return true;
  const gravado = Date.parse(versionUpdatedAt);
  if (Number.isNaN(gravado)) return true;
  // Empate conta como "o host ainda não falou": a escrita do `run_result` e a
  // do heartbeat são de relógios diferentes, e na janela de um segundo o degrau
  // seguro é o que NÃO volta a oferecer a versão já instalada.
  return gravado <= terminou;
}
