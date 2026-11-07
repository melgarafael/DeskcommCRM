/**
 * QUAL FUNIL A ÂNCORA DA URL PEDE PARA ABRIR (#4083).
 *
 * A tela de Etapas do funil recolhe cada funil num acordeão. As âncoras que já
 * existiam entre as duas seções (`#etapas-<id>` e `#mapeamento-<id>`, de
 * `ancoraDasEtapas`/`ancoraDoMapeamento`) continuam sendo o link que leva de uma
 * etapa ao mapeamento do MESMO funil — e, com os cards recolhidos, elas
 * precisam ABRIR o card certo. Sem isto, o clique mudava o hash e não mostrava
 * nada: o alvo estava dentro de um painel desmontado.
 *
 * Função pura e fora do componente por dois motivos: o parse do hash é a parte
 * que erra (barra, `#` duplicado, hash de outra tela) e é testável sem DOM; e o
 * cartão aberto por âncora sobrevive ao F5 — o estado nasce da URL, não de um
 * `useState` que o recarregamento zera.
 */
export function funilDaAncora(
  hash: string | null | undefined,
  idsDosFunis: readonly string[],
): string | null {
  if (!hash) return null;
  const alvo = hash.replace(/^#+/, "").trim();
  if (!alvo) return null;
  for (const id of idsDosFunis) {
    if (alvo === `etapas-${id}` || alvo === `mapeamento-${id}`) return id;
  }
  return null;
}
