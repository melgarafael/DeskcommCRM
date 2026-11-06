/**
 * A ORDEM DA RESPOSTA RÁPIDA — a conta que a rota e a tela compartilham (#3244).
 *
 * ─── A posição nasce do VIZINHO, não de um número ───────────────────────────
 *
 * A tela manda em que resposta o operador soltou (`depois_de`, o vizinho da
 * ESQUERDA — `null` = primeira da lista), e a posição sai da média entre esse
 * vizinho e o SEGUINTE. É o mesmo desenho da reordenação de etapa do funil
 * (`app/api/v1/pipelines/[id]/stages/[stageId]/route.ts`) e do quadro
 * (`lib/kanban/fractional-indexing.ts`): quem arrasta sabe onde a linha caiu,
 * não qual fração de posição isso vira; e só a linha arrastada é escrita.
 *
 * ─── Por que fracionária ────────────────────────────────────────────────────
 *
 * Escrever SÓ a linha arrastada é o que faz a reordenação conviver com a RLS: o
 * papel que pode escrever a própria resposta pessoal não escreve a compartilhada
 * (`message_templates_write`), então renumerar a lista inteira a cada arrasto
 * exigiria permissão sobre linhas que não são dele. Um inteiro obrigaria a
 * renumerar; a média entre vizinhas, não.
 *
 * ─── O empate, e por que ele é tratado aqui ─────────────────────────────────
 *
 * Duas respostas ainda podem dividir a MESMA posição: a criação grava um passo
 * acima da primeira da lista (`posicaoEntre(null, menor)`), e duas criações
 * simultâneas leem a mesma primeira. A coluna é `numeric` (como
 * `position_in_stage`), mas a conta é feita aqui, em `double`: a média entre duas
 * iguais não existe e a média entre duas que só diferem no último bit pode não
 * caber entre elas. `posicaoEntre` devolve `null` nesses casos e quem
 * chama RENUMERA a lista visível — nunca grava `NaN`, que ordenaria como
 * `nulls last` e sumiria com a linha do lugar onde o operador a soltou.
 */

/** O passo entre duas posições — o mesmo `STEP` de `lib/kanban/fractional-indexing.ts`. */
export const PASSO_DA_ORDEM = 1000;

/**
 * A posição de quem se solta ENTRE `anterior` e `proxima`.
 *
 * `null` dos dois lados é lista vazia; `null` de um lado é o topo ou o fim. E
 * `null` de RETORNO é "não há posição representável aqui" — empate entre as
 * duas vizinhas, ou precisão do `double` esgotada —, que é o sinal para
 * reNumerar a lista em vez de gravar um número inválido.
 */
export function posicaoEntre(anterior: number | null, proxima: number | null): number | null {
  if (anterior === null && proxima === null) return PASSO_DA_ORDEM;
  if (anterior === null) return proxima! - PASSO_DA_ORDEM;
  if (proxima === null) return anterior + PASSO_DA_ORDEM;
  if (anterior >= proxima) return null;
  const media = (anterior + proxima) / 2;
  // A média tem de caber ESTRITAMENTE entre as duas: com `anterior` e `proxima`
  // colados no último bit do double, `(a + b) / 2` arredonda para um dos dois.
  if (media <= anterior || media >= proxima) return null;
  return media;
}

/**
 * A posição de quem está no índice `i` da lista RE-NUMERADA — quando a média não
 * existe, a lista visível inteira ganha posições espaçadas e na ordem pedida.
 *
 * Começa em `PASSO_DA_ORDEM`, e as posições ficam todas positivas e espaçadas.
 * A resposta criada depois disso nasce um passo acima da primeira (`0`, depois
 * `-1000`…), então continua no topo sem precisar de renumeração.
 */
export function ordemDaRenumeracao(indice: number): number {
  return (indice + 1) * PASSO_DA_ORDEM;
}
