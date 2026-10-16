/**
 * O CONTRASTE "NO MODO ESCURO" MEDE O BOTÃO QUE O ESCURO PINTA.
 *
 * Com a segunda cor (#2482), o tema escuro deriva dela — mas o cartão "O texto
 * em cima dos botões" seguia lendo a derivação da cor PRINCIPAL. Medido na
 * prova em tela do #2682 (#1C261D + #D9AC62): a tela dizia 6,7:1, que é o
 * contraste do `#8a948b` que o escuro não pinta mais; o botão pintado era
 * `#e9b762`, 11,4:1. O número descrevia um bloco que não existe na tela.
 *
 * E o resto que o #2687 declarou de fora, fechado aqui: a TIRA DE TONS seguia
 * desenhando a escala da cor principal, e com a segunda cor o degrau marcado do
 * tema escuro — que pertence à escala da SEGUNDA — caía sobre ela. O segundo
 * bloco mede, no `FormularioDaMarca` real, que a tira passa a desenhar a escala
 * da mesma cor cujo degrau ela marca.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
// O formulário é renderizado de verdade; só o que sai do escopo desta medição
// (navegação, toast, server action, upload de logo) fica de fora.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/settings/updateBranding", () => ({ updateBranding: vi.fn() }));
vi.mock("@/components/branding/CampoDeLogo", () => ({ CampoDeLogo: () => null }));
vi.mock("@/components/branding/CampoDoIconeDaAba", () => ({ CampoDoIconeDaAba: () => null }));

import { FormularioDaMarca } from "@/app/admin/(protected)/marca/_form";
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

const FORM_GRAVADA = {
  app_name: null,
  logo_url: null,
  logo_path: null,
  accent_hex: "#1c261d",
  accent_dark_hex: "#d9ac62",
  show_powered_by: false,
} as const;

function renderizarFormulario(corPrincipal: string, corEscura: string | null) {
  render(
    <FormularioDaMarca
      gravada={{ ...FORM_GRAVADA, accent_hex: corPrincipal, accent_dark_hex: corEscura }}
      nomeEmVigor="DeskcommCRM"
      logoEmVigor={null}
      logoDoAmbiente={null}
      origens={{ nome: "tela", logoUrl: "tela", cor: "tela" }}
      definidoNestaTela
      fallbackEm={null}
      fallbackMotivo={null}
    />,
  );
}

/** As tiras desenhadas — o `role="img"` que o próprio componente declara. */
function tiras(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="img"][aria-label^="Escala de"]'),
  );
}

function tonsDaTira(tira: HTMLElement): string[] {
  return Array.from(tira.querySelectorAll<HTMLElement>("[title]")).map((celula) => celula.title);
}

/** Os tons em que a marcação foi desenhada, na ordem da escala. */
function degrausMarcados(tira: HTMLElement): string[] {
  return Array.from(tira.querySelectorAll<HTMLElement>("[title]"))
    .filter((celula) => celula.style.boxShadow !== "")
    .map((celula) => celula.title);
}

describe("tira de tons da marca: a escala desenhada é a da cor que ela marca", () => {
  it("as duas escalas diferem no escuro (senão o teste não distingue nada)", () => {
    expect([...SEGUNDA.rampa]).not.toEqual([...PRINCIPAL.rampa]);
    expect(SEGUNDA.escuro.accent).not.toBe(PRINCIPAL.escuro.accent);
  });

  it("⭐ com a segunda cor, a tira do escuro desenha a escala DELA e marca o degrau dela", () => {
    renderizarFormulario("#1c261d", "#d9ac62");

    const todas = tiras();
    // Duas escalas → duas tiras. Com o defeito de volta (escala única) esta é a
    // primeira linha a cair.
    expect(todas).toHaveLength(2);

    const daPrincipal = todas.find((t) => tonsDaTira(t).join() === [...PRINCIPAL.rampa].join());
    const daSegunda = todas.find((t) => tonsDaTira(t).join() === [...SEGUNDA.rampa].join());
    if (!daPrincipal || !daSegunda) throw new Error("as duas escalas não foram desenhadas");

    // O degrau marcado do escuro pertence à escala em que ele foi desenhado —
    // é a asserção que o defeito (marcação sobre a escala da principal) derruba.
    expect(degrausMarcados(daSegunda)).toEqual([SEGUNDA.escuro.accent]);
    // E a escala da principal segue marcando a cor da pessoa (degrau K) e o
    // botão do modo claro.
    expect(degrausMarcados(daPrincipal)).toContain(PRINCIPAL.marca);
    expect(degrausMarcados(daPrincipal)).toContain(PRINCIPAL.claro.accent);
  });

  it("sem a segunda cor, continua uma tira só, na escala da principal", () => {
    renderizarFormulario("#1c261d", null);

    const [unica] = tiras();
    if (!unica) throw new Error("a tira não foi desenhada");
    expect(tiras()).toHaveLength(1);
    expect(tonsDaTira(unica)).toEqual([...PRINCIPAL.rampa]);
    expect(degrausMarcados(unica)).toContain(PRINCIPAL.escuro.accent);
  });

  it("a legenda e os hex não mudam: cada papel continua com o seu tom", () => {
    renderizarFormulario("#1c261d", "#d9ac62");

    const doEscuro = screen.getByText("Botões no modo escuro").closest("li");
    if (!doEscuro) throw new Error("sem a linha do escuro");
    expect(doEscuro.textContent).toContain(SEGUNDA.escuro.accent);
  });
});
