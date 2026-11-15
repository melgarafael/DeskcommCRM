/**
 * A RÉGUA DE RECORTE, PROVADA SEM NAVEGADOR.
 *
 * O e2e que usa esta régua (`tests/e2e/ia-no-celular.spec.ts`, passo 8) só roda
 * no CI, e o CI não tem rerun: um vermelho ali custa um push inteiro para
 * reproduzir. Aqui ficam as duas contas que decidem aquele passo — o ajuste de
 * rolagem e a asserção — com os NÚMEROS MEDIDOS no job `e2e-parte (7)` do
 * #4613 (14/11/2026) e do #4530, que falharam com a mesma frase:
 *
 *   o alvo não está inteiro no recorte (topo da caixa 114px, topo do recorte 128px)
 *
 * Os dois números não são um azar de layout: 114 = 128 − 14, os 14px do
 * `-inset-3.5` que o `::before` do link declara acima do texto. O painel do
 * `CaseDetail` estava rolado 40px (o nome e o telefone do contato, 24 + 16), o
 * texto do link encostado na borda de cima do recorte e o halo — metade de
 * cima do alvo de 44px — inteiro do lado de fora.
 */
import { describe, expect, it } from "vitest";

import { ajusteDeRolagem, caixaInteiraNoRecorte, type Caixa } from "../e2e/helpers/recorte-do-alvo";

/** O recorte do painel do caso a 390×844, medido no CI. */
const RECORTE: Caixa = { top: 128, bottom: 782 };

/** A caixa do alvo (texto 16px + 2×14px de halo) encostada no topo do recorte. */
const CAIXA_CORTADA: Caixa = { top: 114, bottom: 158 };

/** Os 4px que os pontos de fora andam além da borda da caixa (ver o spec). */
const FOLGA_DOS_CONTROLES = 8;

describe("recorte do alvo de toque", () => {
  it("a caixa cortada em 14px NÃO está inteira no recorte", () => {
    // O estado que o CI mediu. Se alguém afrouxar a asserção para aceitar 14px
    // de halo fora, este caso passa a dizer o contrário do que aconteceu.
    expect(caixaInteiraNoRecorte(CAIXA_CORTADA, RECORTE)).toBe(false);
    expect(caixaInteiraNoRecorte({ top: 128, bottom: 172 }, RECORTE)).toBe(true);
  });

  it("o ajuste sobe o painel só o que falta, e o encaixe então está inteiro", () => {
    const ajuste = ajusteDeRolagem(CAIXA_CORTADA, RECORTE, FOLGA_DOS_CONTROLES);

    // Negativo = sobe o conteúdo. 114 está 22px acima do topo + a folga dos
    // controles (128 + 8): rolar 40px até o topo do caso deixa 8px de respiro.
    expect(ajuste).toBe(-22);
    expect(ajuste).toBeLessThan(0);

    const encaixada: Caixa = { top: CAIXA_CORTADA.top - ajuste, bottom: CAIXA_CORTADA.bottom - ajuste };
    expect(encaixada).toEqual({ top: 136, bottom: 180 });
    expect(caixaInteiraNoRecorte(encaixada, RECORTE)).toBe(true);

    // E os pontos de controle, 4px fora da caixa, continuam DENTRO do recorte —
    // é o que dá sentido ao `false` deles: um controle fora do recorte não
    // prova nada sobre a borda do alvo.
    expect(encaixada.top - FOLGA_DOS_CONTROLES).toBeGreaterThanOrEqual(RECORTE.top);
  });

  it("caixa que já está inteira não é mexida", () => {
    const inteira: Caixa = { top: 200, bottom: 244 };
    expect(ajusteDeRolagem(inteira, RECORTE, FOLGA_DOS_CONTROLES)).toBe(0);
    expect(caixaInteiraNoRecorte(inteira, RECORTE)).toBe(true);
  });

  it("caixa cortada embaixo desce o conteúdo, e não sobe", () => {
    const cortadaEmbaixo: Caixa = { top: 760, bottom: 804 };
    const ajuste = ajusteDeRolagem(cortadaEmbaixo, RECORTE, 0);
    expect(ajuste).toBe(22);
    expect(caixaInteiraNoRecorte({ top: 760 - ajuste, bottom: 804 - ajuste }, RECORTE)).toBe(true);
  });

  it("o ajuste é ponto fixo: aplicado uma vez, a segunda passada devolve 0", () => {
    // O spec mede, ajusta e mede de novo, até três passadas, porque o chat do
    // caso pode estar rolando por conta própria quando a medida começa. Se o
    // ajuste oscilasse, a terceira medida seria de novo a cortada.
    const caixas: Caixa[] = [CAIXA_CORTADA, { top: 760, bottom: 804 }, { top: 200, bottom: 244 }];
    for (const caixa of caixas) {
      const ajuste = ajusteDeRolagem(caixa, RECORTE, FOLGA_DOS_CONTROLES);
      const depois: Caixa = { top: caixa.top - ajuste, bottom: caixa.bottom - ajuste };
      expect(ajusteDeRolagem(depois, RECORTE, FOLGA_DOS_CONTROLES), `oscilou em ${JSON.stringify(caixa)}`).toBe(0);
      expect(caixaInteiraNoRecorte(depois, RECORTE)).toBe(true);
    }
  });

  it("caixa mais alta que o recorte reprova em vez de fingir encaixe", () => {
    // Sem esta guarda, "cabe" viraria "não reclama": um recorte de 30px com um
    // alvo de 44px tem que continuar vermelho.
    const recorteBaixo: Caixa = { top: 128, bottom: 158 };
    const alvo: Caixa = { top: 114, bottom: 158 };
    const ajuste = ajusteDeRolagem(alvo, recorteBaixo, FOLGA_DOS_CONTROLES);
    expect(caixaInteiraNoRecorte({ top: alvo.top - ajuste, bottom: alvo.bottom - ajuste }, recorteBaixo)).toBe(false);
  });
});
