/**
 * AS DUAS COLUNAS DA TELA DE NOVO TENANT FALAM A MESMA LÍNGUA — issue #4526.
 *
 * O relato: as frases do onboarding "não estão compatíveis ou com discordância",
 * e a coluna citada — "E nunca irá fazer - Respeitar quem pediu para parar" —
 * "ficou muito estranho". Estranho porque é literalmente o título da coluna
 * colado no primeiro item: "nunca vai fazer" + "Respeitar quem pediu para parar"
 * diz o CONTRÁRIO do que a conferência faz. E metade dos itens começava por
 * "Não", a outra metade por verbo na afirmativa, e ainda "Só oferecer…" e
 * "Deixar valores…" — quatro formas verbais diferentes na mesma lista.
 *
 * O que este teste guarda, em três frentes:
 *
 *   1. PARALELISMO — todo item é uma ação no infinitivo, e nenhum começa por
 *      "E", "Não", "Nunca" ou "Só". A coluna lê como lista de ações proibidas
 *      ("O que ele nunca faz: Prometer preço…"), não como frase truncada.
 *   2. NADA SOME — a lista do onboarding cobre as MESMAS conferências, na
 *      mesma ordem, que `CONFERENCIAS_DE_SAIDA`. Apagar um item para "resolver"
 *      a frase é o jeito errado de fechar esta issue: o que está na vista é o
 *      que o runtime promete (ver `seguranca-lista-casa-com-a-cadeia`).
 *   3. A NOTA DIZ A VERDADE — a frase antiga afirmava que nenhuma conferência
 *      tem interruptor; quatro delas têm (`escolha`/`escolhaEmOutraTela`), e a
 *      nota que ficou não afirma isso.
 *
 * As frases vêm de `NUNCA_FAZ`, e não do `rotulo` da conferência: o painel do
 * agente usa o rótulo como TÍTULO da proteção ("Respeitar quem pediu para
 * parar"), forma que, debaixo de "nunca faz", inverte o sentido. São dois
 * lugares com duas falas, presos à mesma lista de gates por chave.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("@/app/actions/onboarding/createDefaultAgent", () => ({
  createDefaultAgent: vi.fn(),
  skipAi: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { SetupAiForm } from "@/app/onboarding/setup-ai/_form";
import { CONFERENCIAS_DE_SAIDA, NUNCA_FAZ } from "@/lib/ai/guardrails/lista-de-conferencia";

/** As capacidades reais vêm do catálogo; aqui só a forma — o que se mede é a coluna do "nunca". */
const CAPACIDADES = ["Ver o que a empresa atende", "Mover oportunidade de etapa"];
const FRASES = Object.values(NUNCA_FAZ);
const TITULO_ESQUERDA = "O que ele já sabe fazer";
const TITULO_DIREITA = "O que ele nunca faz";

function montar() {
  return render(<SetupAiForm capacidades={CAPACIDADES} conferencias={FRASES} />);
}

afterEach(cleanup);

describe("onboarding de novo tenant: frases paralelas, sem rótulo grudado", () => {
  it("a lista do 'nunca' cobre as MESMAS conferências, na mesma ordem — nada some", () => {
    // A chave é o `nome` do gate: é ela que casa a fala com o que roda.
    expect(Object.keys(NUNCA_FAZ)).toEqual(CONFERENCIAS_DE_SAIDA.map((c) => c.nome));
    expect(FRASES).toHaveLength(CONFERENCIAS_DE_SAIDA.length);
  });

  it("todo item é uma ação no infinitivo — nenhum começa por 'E', 'Não', 'Nunca' ou 'Só'", () => {
    for (const frase of FRASES) {
      expect(frase, `"${frase}" abre com rótulo ou negação em vez de ação`).not.toMatch(
        /^(E|Não|Nunca|Só)\b/,
      );
      expect(frase, `"${frase}" não é uma ação no infinitivo`).toMatch(
        /^[A-ZÁÉÍÓÚÂÊÔÃÕ][a-zà-ú]+(ar|er|ir)\b/,
      );
      // Rótulo grudado em item é o defeito relatado ("E nunca irá fazer - …").
      expect(frase, `"${frase}" carrega rótulo de coluna`).not.toContain(" - ");
    }
  });

  it("as duas colunas usam a mesma forma: 'O que ele …' e itens em ação", () => {
    montar();
    const esquerda = screen.getByRole("heading", { name: TITULO_ESQUERDA }).closest("section");
    const direita = screen.getByRole("heading", { name: TITULO_DIREITA }).closest("section");
    expect(esquerda, "a coluna do 'já sabe' não tem título próprio").not.toBeNull();
    expect(direita, "a coluna do 'nunca' não tem título próprio").not.toBeNull();

    const itensDaDireita = within(direita as HTMLElement).getAllByRole("listitem");
    expect(itensDaDireita).toHaveLength(CONFERENCIAS_DE_SAIDA.length);
    // O texto renderizado é o mesmo que o título promete — sem "· E nunca …".
    for (const li of itensDaDireita) {
      expect(li.textContent ?? "").not.toMatch(/^·\s*(E|Não)\b/);
    }
  });

  it("a nota da coluna não afirma que nenhuma conferência tem escolha", () => {
    montar();
    expect(screen.queryByText(/não têm interruptor/i)).toBeNull();
  });
});
