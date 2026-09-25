/**
 * O MARCADOR DE HIDRATAÇÃO — a calibração de um detalhe interno do React que as
 * specs da agenda usam como portão.
 *
 * `tests/e2e/helpers/agenda-semana-integra.ts` espera a grade hidratar antes de
 * ler ou clicar, e o sinal que ele usa é a propriedade que o React DOM grava no
 * nó ao assumi-lo: `__reactFiber$<hash>`. Isso é interno do React, não API — e
 * um detalhe interno usado sem calibração é uma sonda que pode morrer calada:
 * se uma atualização renomear a propriedade, o portão nunca fica verdadeiro e
 * TODA spec de agenda passa a reprovar por timeout, com a mensagem falando de
 * hidratação onde o defeito é o nome da propriedade.
 *
 * Este teste é barato e fecha essa porta: ele renderiza um componente de
 * verdade e prova que o prefixo existe NESTA versão do React. Vermelho aqui
 * significa "troque `MARCA_DE_HIDRATACAO` no helper", e diz isso na mensagem.
 *
 * ⚠️ Ele NÃO prova que a grade hidrata — prova que o SINAL existe. Quem prova a
 * hidratação é a spec de Playwright, no navegador real.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MARCA_DE_HIDRATACAO } from "../e2e/helpers/agenda-semana-integra";

describe("o marcador de hidratação do React", () => {
  it("existe no nó do DOM depois que o React assume, com o prefixo que o portão espera", () => {
    const { getByTestId } = render(<button data-testid="alvo">ok</button>);
    const no = getByTestId("alvo");

    const chaves = Object.keys(no);
    expect(
      chaves.some((k) => k.startsWith(MARCA_DE_HIDRATACAO)),
      `nenhuma propriedade começando com "${MARCA_DE_HIDRATACAO}" no nó do DOM. ` +
        "O React renomeou a marca interna que o portão de hidratação das specs de " +
        "agenda espera — troque `MARCA_DE_HIDRATACAO` em " +
        `tests/e2e/helpers/agenda-semana-integra.ts. Chaves vistas: ${chaves.join(", ")}`,
    ).toBe(true);
  });

  it("não existe num nó que o React nunca tocou — o sinal DISTINGUE, não carimba tudo", () => {
    // Controle positivo do próprio portão: sem isto, um marcador que estivesse
    // em todo nó do documento deixaria o portão verde antes da hidratação, que
    // é exatamente o estado que ele existe para recusar.
    const cru = document.createElement("button");
    expect(Object.keys(cru).some((k) => k.startsWith(MARCA_DE_HIDRATACAO))).toBe(false);
  });
});
