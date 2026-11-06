/**
 * O QUADRO DE TAREFAS — as colunas são as SITUAÇÕES, e nada some.
 *
 * Este módulo é puro de propósito: a regra "em que coluna esta tarefa cai" não
 * precisa de React, de fetch nem de banco para ser provada. É a mesma divisão
 * de `lib/tarefas/tipos.ts` (códigos e regra aqui, rótulo na tela via `t()`).
 *
 * ─── Por que existe uma coluna que não é situação ──────────────────────────
 *
 * `crm_tasks.status` é `not null` com CHECK nos quatro valores, então em teoria
 * toda linha tem coluna. Na prática a tela recebe o que o SERVIDOR mandar: uma
 * instalação que aplicou uma migration com situação nova, um `status` que a
 * versão antiga do app não conhece, ou um registro mexido à mão. Um quadro que
 * monta as colunas a partir de uma lista fixa e faz `find(coluna)` descarta
 * esses cartões EM SILÊNCIO — e "a tarefa desapareceu do quadro" é
 * indistinguível de "a tarefa foi apagada".
 *
 * Por isso o agrupamento devolve uma coluna `sem_situacao` para tudo o que não
 * casa, e ela só aparece quando tem cartão dentro. As quatro colunas de
 * situação aparecem SEMPRE, mesmo vazias: um quadro em que a coluna "Concluída"
 * some quando ninguém concluiu nada muda de forma a cada carga.
 */
import { SITUACOES_DA_TAREFA, type SituacaoDaTarefa, type Tarefa } from "./tipos";

/** A coluna de tudo o que não é uma situação conhecida. Não é valor de banco. */
export const COLUNA_SEM_SITUACAO = "sem_situacao" as const;
export type ColunaDoQuadro = SituacaoDaTarefa | typeof COLUNA_SEM_SITUACAO;

/**
 * O teto de carga do quadro — o mesmo número que a tela manda em `?limite=`.
 *
 * É MENOR que o teto da lista (500, em `app/api/v1/tasks/route.ts`) por um
 * motivo de produto: o quadro desenha todas as colunas de uma vez, e um cartão
 * de quadro carrega mais pixel que uma linha de lista. Quando a resposta bate
 * neste número, a tela DIZ que está cortada — o limite existe para não derrubar
 * a aba, não para esconder que há mais tarefas.
 */
export const LIMITE_DO_QUADRO = 200;

const CONHECIDAS = new Set<string>(SITUACOES_DA_TAREFA);

/** Em que coluna a tarefa cai. Desconhecido ou nulo vai para "Sem situação". */
export function colunaDaTarefa(tarefa: Pick<Tarefa, "status">): ColunaDoQuadro {
  const status = tarefa.status as string | null | undefined;
  return status && CONHECIDAS.has(status) ? (status as SituacaoDaTarefa) : COLUNA_SEM_SITUACAO;
}

export interface ColunaDeTarefas<T> {
  coluna: ColunaDoQuadro;
  tarefas: T[];
}

/**
 * Agrupa para o quadro preservando a ordem em que as tarefas chegaram (a rota
 * já entrega por prazo). A coluna `sem_situacao` vai por ÚLTIMO e só entra se
 * tiver conteúdo.
 */
export function colunasDoQuadro<T extends Pick<Tarefa, "status">>(
  tarefas: readonly T[],
): Array<ColunaDeTarefas<T>> {
  const porColuna = new Map<ColunaDoQuadro, T[]>();
  for (const coluna of SITUACOES_DA_TAREFA) porColuna.set(coluna, []);
  porColuna.set(COLUNA_SEM_SITUACAO, []);

  for (const tarefa of tarefas) {
    porColuna.get(colunaDaTarefa(tarefa))!.push(tarefa);
  }

  const colunas: Array<ColunaDeTarefas<T>> = SITUACOES_DA_TAREFA.map((coluna) => ({
    coluna,
    tarefas: porColuna.get(coluna) ?? [],
  }));

  const semSituacao = porColuna.get(COLUNA_SEM_SITUACAO) ?? [];
  if (semSituacao.length > 0) colunas.push({ coluna: COLUNA_SEM_SITUACAO, tarefas: semSituacao });

  return colunas;
}

/** A carga veio no teto? Então pode haver mais tarefa do que a tela mostra. */
export function cargaAtingiuOLimite<T>(
  tarefas: readonly T[],
  limite: number = LIMITE_DO_QUADRO,
): boolean {
  return tarefas.length >= limite;
}
