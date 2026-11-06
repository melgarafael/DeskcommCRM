import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn(), patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
// A tradução não é o assunto aqui: a chave em português é o texto.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { ProdutosClient } from "@/app/app/products/_client";
import { formatCents } from "@/lib/money";
import type { Produto } from "@/lib/schemas/produtos";

/**
 * A LINHA DA LISTA DE PRODUTOS CABE NO CELULAR (#3922).
 *
 * A 375 px o `li` de cada produto media `scrollWidth` 348 contra
 * `clientWidth` 293 — 55 px a mais do que o espaço. Quem cedia era o único
 * item flexível da linha: a coluna do nome, `flex-1` com `min-w-0`, encolhia
 * até 0 px e o nome sumia. Preço e os três botões são `shrink-0`/`nowrap`,
 * então o excedente não tinha para onde ir e o «Desativar» saía cortado.
 *
 * ## A prova aqui é por CLASSE, e isso é declarado
 *
 * O jsdom não faz layout: `getBoundingClientRect` devolve zeros e `scrollWidth`
 * não reflete caixa nenhuma. Uma "medição em pixel" neste arquivo seria mentira
 * com cara de teste. O que se afirma aqui é o CONTRATO de classes que faz o
 * navegador quebrar a linha em vez de estourar:
 *
 *  1. abaixo de `md` a linha aceita quebrar (`max-md:flex-wrap`);
 *  2. as ações são um grupo próprio que desce inteiro (`max-md:w-full`) e, se
 *     nem assim couber, quebra entre si em vez de vazar (`max-md:flex-wrap`);
 *  3. a coluna do nome segue `min-w-0 flex-1` — encolhe com reticências em vez
 *     de empurrar preço e ações para fora;
 *  4. de `md` para cima as classes são EXATAMENTE as de antes: tirando os
 *     tokens `max-md:`, sobra a lista que o computador já usava. É esta a
 *     garantia de que o conserto não vira coluna única no desktop.
 *
 * A régua em pixel de verdade é `getBoundingClientRect`/`scrollWidth` numa tela
 * semeada — o modelo está em
 * `tests/e2e/contatos-em-cartao-no-celular.spec.ts`. Aqui não há navegador.
 */

const TEXTOS = { titulo: "Produtos", subtitulo: "", vazio: "vazio", vazioDica: "" };

function produto(over: Partial<Produto> = {}): Produto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    codigo: "IP15",
    nome: "iPhone 15",
    descricao: null,
    marca: null,
    categoria: null,
    capacidade: null,
    preco_cents: 24990,
    moeda: "BRL",
    custo_cents: null,
    controla_estoque: false,
    quantidade: 0,
    ativo: true,
    origem: "manual",
    imagem_url: null,
    fotos: [],
    updated_at: "2026-09-03T00:00:00.000Z",
    ...over,
  };
}

function tela(p: Produto, podeEditar = true) {
  return render(
    <ProdutosClient
      inicial={[p]}
      total={1}
      pagina={1}
      porPagina={1}
      buscaInicial=""
      urlsDasFotos={{}}
      podeEditar={podeEditar}
      textos={TEXTOS}
    />,
  );
}

/**
 * A linha do produto: o div que abre o `li`. Ancorado na estrutura, e não num
 * `data-testid` novo — o mesmo seletor enxerga a linha antes e depois do
 * conserto, então o vermelho deste arquivo é o do layout, não o de um atributo
 * que ainda não existe.
 */
function linha(): HTMLElement {
  return screen.getByTestId("produto-IP15").firstElementChild as HTMLElement;
}

/** O grupo das ações: o pai do botão «Desativar». */
function acoes(): HTMLElement {
  return screen.getByTestId("alternar-IP15").parentElement as HTMLElement;
}

/** As classes de um elemento, sem repetição nem vazio. */
function classes(el: Element): string[] {
  return [...new Set(el.className.split(/\s+/).filter(Boolean))];
}

/** O que vale de `md` para cima: o que sobra tirando os tokens `max-md:`. */
function semACelular(tokens: string[]): string[] {
  return tokens.filter((c) => !c.startsWith("max-md:"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a linha do produto quebra em vez de transbordar no celular", () => {
  it("abaixo de md a linha aceita quebrar — sem isso o nome é espremido a 0 px", () => {
    tela(produto());

    const tokens = classes(linha());
    expect(tokens).toContain("max-md:flex-wrap");
    // Duas fileiras no celular não pedem o `gap-4` de 16 px do computador: o
    // respiro entre elas é outro, e é declarado.
    expect(tokens).toEqual(expect.arrayContaining(["max-md:gap-x-3", "max-md:gap-y-1"]));
  });

  it("as ações descem como grupo inteiro e, se ainda faltar espaço, quebram entre si", () => {
    tela(produto());

    const grupo = acoes();
    // No defeito, «Desativar» era item solto da linha: preço, Editar, Fotos e
    // Desativar disputavam a mesma fileira e o último saía cortado.
    expect(grupo).not.toBe(linha());
    expect(classes(grupo)).toEqual(
      expect.arrayContaining(["max-md:w-full", "max-md:flex-wrap", "max-md:justify-end"]),
    );

    // As três ações continuam lá, dentro do grupo.
    for (const rotulo of ["Editar", "Fotos (0)", "Desativar"]) {
      expect(screen.getByRole("button", { name: rotulo })).toBeInTheDocument();
      expect(grupo.contains(screen.getByRole("button", { name: rotulo }))).toBe(true);
    }
  });

  it("o nome e o preço continuam na primeira fileira, com o nome em coluna flexível", () => {
    const p = produto();
    tela(p);

    // O nome é texto renderizado, não espaço vazio: é ele que sumia com a
    // coluna em 0 px.
    const nome = screen.getByText(p.nome);
    // A coluna do nome: `min-w-0 flex-1` — encolhe (com reticências) em vez de
    // empurrar preço e ações para fora da linha.
    const coluna = nome.parentElement as HTMLElement;
    expect(classes(coluna)).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
    expect(coluna.parentElement).toBe(linha());
    expect(nome).toHaveClass("truncate");

    // O preço é irmão da coluna do nome, não filho: continua na fileira de cima.
    const esperado = formatCents(p.preco_cents, p.moeda).replace(/\s/g, " ");
    const preco = screen.getByText(
      (_, el) =>
        el?.tagName === "SPAN" && (el.textContent ?? "").replace(/\u00a0/g, " ") === esperado,
    );
    expect(preco.parentElement).toBe(linha());
    expect(classes(preco)).toContain("shrink-0");
  });

  it("de md para cima a linha é exatamente a de antes: nada de coluna única no desktop", () => {
    tela(produto());

    // Tudo o que o conserto acrescentou está sob `max-md:`. Tirando esses
    // tokens, sobra a linha original, palavra por palavra — o desktop não muda.
    expect(semACelular(classes(linha()))).toEqual(["flex", "items-center", "gap-4", "p-3"]);
    expect(semACelular(classes(acoes()))).toEqual(["flex", "items-center", "gap-4"]);
    // E nenhum `flex-col`/`w-full` sem condição, que é como um conserto de
    // celular viraria coluna única no computador.
    for (const token of [...classes(linha()), ...classes(acoes())]) {
      expect(["flex-col", "w-full", "flex-wrap", "justify-end", "gap-y-1"]).not.toContain(token);
    }
  });

  it("sem permissão de edição a linha não ganha grupo de ações — mas continua quebrando", () => {
    tela(produto(), false);

    expect(screen.queryByRole("button", { name: "Desativar" })).toBeNull();
    // O 0 px do nome não era culpa do botão: com ou sem ações, a linha quebra.
    expect(classes(linha())).toContain("max-md:flex-wrap");
    // Sem ações, a linha tem só dois filhos: a coluna do nome e o preço.
    expect(linha().children).toHaveLength(2);
  });
});
