/**
 * O CONTRASTE "NO MODO ESCURO" MEDE O BOTÃO QUE O ESCURO PINTA.
 *
 * Com a segunda cor (#2482), o tema escuro deriva dela — mas o cartão "O texto
 * em cima dos botões" seguia lendo a derivação da cor PRINCIPAL. Medido na
 * prova em tela do #2682 (#1C261D + #D9AC62): a tela dizia 6,7:1, que é o
 * contraste do `#8a948b` que o escuro não pinta mais; o botão pintado era
 * `#e9b762`, 11,4:1. O número descrevia um bloco que não existe na tela.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { EstadoDaMarca } from "@/app/admin/(protected)/marca/_estado";
import { derivarMarca, type TokensDoTema } from "@/lib/branding/contraste";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";

afterEach(cleanup);

const PRINCIPAL = derivarMarca("#1c261d", REGUA_DO_PRODUTO);
const SEGUNDA = derivarMarca("#d9ac62", REGUA_DO_PRODUTO);

function razaoExibida(tokens: TokensDoTema): string {
  const par = tokens.pares.find((p) => p.papel === "--color-accent-fg");
  if (!par) throw new Error("sem o par do texto do botão");
  return `${par.razao.toFixed(1).replace(".", ",")}:1`;
}

function linha(rotulo: string): string {
  const item = screen.getByText(`${rotulo}:`).closest("li");
  if (!item) throw new Error(`sem a linha ${rotulo}`);
  return item.textContent ?? "";
}

function renderizar(derivadaEscura: typeof PRINCIPAL | null) {
  render(
    <EstadoDaMarca
      origens={{ nome: "padrao", logoUrl: "padrao", cor: "banco" }}
      definidoNestaTela
      fallbackEm={null}
      fallbackMotivo={null}
      derivada={PRINCIPAL}
      derivadaEscura={derivadaEscura}
      avisos={[]}
      seriaAplicada
    />,
  );
}

describe("cartão de contraste da marca com a cor do tema escuro", () => {
  it("as duas derivações dão números diferentes no escuro (senão o teste não distingue nada)", () => {
    expect(razaoExibida(SEGUNDA.escuro)).not.toBe(razaoExibida(PRINCIPAL.escuro));
  });

  it("⭐ com a segunda cor, 'No modo escuro' mostra o contraste da segunda", () => {
    renderizar(SEGUNDA);
    expect(linha("No modo escuro")).toContain(razaoExibida(SEGUNDA.escuro));
    expect(linha("No modo claro")).toContain(razaoExibida(PRINCIPAL.claro));
  });

  it("sem a segunda cor, o escuro segue a principal, como antes", () => {
    renderizar(null);
    expect(linha("No modo escuro")).toContain(razaoExibida(PRINCIPAL.escuro));
  });
});
