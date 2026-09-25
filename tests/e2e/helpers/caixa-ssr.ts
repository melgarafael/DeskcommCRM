/**
 * Quais caixas do streaming SSR (`<div hidden id="S:N">`) NÃO têm revelador no
 * documento — a regra da spec `buffer-ssr-caixa-orfa`, em função pura para o
 * `verify` vigiá-la sem navegador.
 *
 * O `react-dom` servidor que vem com o Next 16.3.5 tem TRÊS instruções que
 * consomem uma caixa (`react-dom-server.node.production.js`):
 *   · `$RC("B:N","S:N")` — completa um boundary;
 *   · `$RR("B:N","S:N",[…])` — completa um boundary que traz folhas de estilo;
 *   · `$RS("S:N","P:N")` — completa um SEGMENTO.
 * Contar só o `$RC` acusou como órfã a caixa `S:1` drenada por `$RS` num
 * documento correto (run 36015154699 do PR #1600).
 *
 * O id casa ENTRE ASPAS, para `S:1` não casar `S:10`.
 */
export const REVELADOR_DE_CAIXA = /\$R[CRS]\(/;

export function caixasSemRevelador(staged: readonly string[], textosDeScripts: readonly string[]): string[] {
  const reveladores = textosDeScripts.filter((t) => REVELADOR_DE_CAIXA.test(t));
  return staged.filter((id) => !reveladores.some((t) => t.includes(`"${id}"`)));
}
