/**
 * Quantos cards uma coluna do quadro desenha (#4788).
 *
 * As colunas de GANHO e de PERDA mostram os negócios de 50 em 50 ("Mostrar
 * mais"); as colunas abertas mostram todos, como sempre. Um funil com milhares
 * de perdidos fazia o quadro desenhar — e o arraste medir — milhares de cards
 * que ninguém lê. O contador, os totais e "selecionar a etapa" continuam
 * contando a coluna inteira: o corte é só do que é desenhado.
 *
 * O corte é sempre um PREFIXO da lista da coluna (a ordem do quadro,
 * `compararNaEtapa`). É isso que mantém o arraste certo: o índice que o dnd
 * devolve na parte mostrada é o mesmo índice na lista inteira, e o vizinho de
 * baixo de quem cai no fim da parte mostrada é o primeiro escondido
 * (`KanbanBoard.handleDragEnd` lê a etapa inteira).
 *
 * Dois cards entram mesmo além do corte:
 *  - o que acabou de ser SOLTO pelo arraste: soltar logo abaixo do 50º grava a
 *    posição entre o 50º e o 51º (escondido), e o card vira o 51º — sem isto ele
 *    sumia da tela na hora;
 *  - o do dossiê aberto (o deep link `?lead=` abre o dossiê de um negócio que
 *    pode estar além do corte).
 * O limite sobe até eles e FICA (estado da coluna): fechar o dossiê não faz o
 * card sumir de baixo do cursor.
 */
export const CARDS_POR_VEZ = 50;

export function colunaLimitada(etapa: {
  is_won?: boolean | null;
  is_lost?: boolean | null;
}): boolean {
  return Boolean(etapa.is_won || etapa.is_lost);
}

/** O limite que inclui os cards que têm de aparecer. Nunca diminui. */
export function limiteQueMostra<T extends { id: string }>(
  cards: readonly T[],
  {
    limitada,
    limite,
    fixos,
  }: { limitada: boolean; limite: number; fixos: ReadonlyArray<string | null | undefined> },
): number {
  if (!limitada) return limite;
  let n = limite;
  for (const id of fixos) {
    if (!id) continue;
    const pos = cards.findIndex((c) => c.id === id);
    if (pos + 1 > n) n = pos + 1;
  }
  return n;
}

export function cardsVisiveisDaColuna<T extends { id: string }>(
  cards: T[],
  { limitada, limite }: { limitada: boolean; limite: number },
): T[] {
  if (!limitada || cards.length <= limite) return cards;
  return cards.slice(0, limite);
}
