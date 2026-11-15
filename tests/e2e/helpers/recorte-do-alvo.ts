/**
 * A RÉGUA DE RECORTE: onde a CAIXA de um alvo cabe dentro do que rola.
 *
 * ## O defeito que este módulo existe para não repetir (medido em 14/11/2026)
 *
 * `ia-no-celular.spec.ts` mede o alvo de toque do «Ver conversa» como caixa: os
 * 16px do texto mais 2×14px do `-inset-3.5` do `::before` = 44px. Antes de
 * medir, a spec põe o estado — zero o `scrollTop` do painel do caso e chama
 * `scrollIntoView({ block: "nearest" })` no link. O job `e2e-parte (7)` do
 * #4613 (head `6626d28e9`) e o do #4530, que nem toca em mensagens, falharam
 * com a MESMA frase e os MESMOS números:
 *
 *   o alvo não está inteiro no recorte (topo da caixa 114px, topo do recorte 128px)
 *
 * 114 é 128 menos 14. O painel do `CaseDetail` estava rolado exatamente os 40px
 * do nome e do telefone do contato, o TEXTO do link encostado na borda de cima
 * do recorte e o halo do `::before` inteiro do lado de fora — o dedo teria 30px
 * do alvo declarado, não 44. `scrollIntoView` só promete a caixa do ELEMENTO:
 * ele não sabe que o alvo declarado é maior que o texto, e `block: "nearest"`
 * para na primeira posição em que o texto aparece. Uma régua que mede 44px e
 * uma rolagem que garante 16px nunca vão concordar.
 *
 * ## O que se faz em vez disso
 *
 * `ajusteDeRolagem` devolve quanto somar ao `scrollTop` do recorte para a CAIXA
 * ficar inteira dentro dele, com `folga` px de respiro nas duas bordas. O
 * respiro existe porque os pontos de controle caem 4px FORA da caixa: um
 * controle que cai fora do recorte não prova nada sobre a borda do alvo — ele
 * some no `elementFromPoint`, e o `false` dele vira sorte. Zero quer dizer "já
 * está inteira", e aí a tela não é mexida à toa.
 *
 * `caixaInteiraNoRecorte` é a asserção, e é a MESMA conta que o ajuste usa.
 * Separar as duas é o que permite provar esta régua em
 * `tests/unit/recorte-do-alvo.test.ts`, sem navegador: o e2e só roda no CI, e
 * uma régua provada só no CI não tem prova de sabotagem.
 */

/** Uma borda de cima e uma de baixo, nas coordenadas do `getBoundingClientRect`. */
export interface Caixa {
  top: number;
  bottom: number;
}

/**
 * Meio pixel de subpixel. `getBoundingClientRect` devolve fração, e uma borda
 * que encosta na outra com 0,3px de diferença não é alvo cortado.
 */
const MEIO_PIXEL = 0.5;

/** A caixa está inteira dentro do recorte? */
export function caixaInteiraNoRecorte(caixa: Caixa, porto: Caixa): boolean {
  return caixa.top >= porto.top - MEIO_PIXEL && caixa.bottom <= porto.bottom + MEIO_PIXEL;
}

/**
 * Quanto somar ao `scrollTop` do recorte para a caixa ficar inteira dentro dele.
 *
 * Positivo desce o conteúdo (a caixa sobe na tela), negativo sobe. `0` = já
 * está inteira, com a `folga` respeitada nas duas bordas.
 *
 * Numa caixa mais alta que o recorte, o encaixe de cima ganha e a asserção
 * reprova — é o comportamento certo: não existe rolagem que caiba o que não
 * cabe, e esconder isso com uma folga maior seria mentir sobre o alvo.
 */
export function ajusteDeRolagem(caixa: Caixa, porto: Caixa, folga = 0): number {
  if (caixa.top < porto.top + folga) return caixa.top - (porto.top + folga);
  if (caixa.bottom > porto.bottom - folga) return caixa.bottom - (porto.bottom - folga);
  return 0;
}
