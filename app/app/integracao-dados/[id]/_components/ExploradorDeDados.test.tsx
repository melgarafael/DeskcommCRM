/**
 * A grade do banco externo começa COMPACTA e uniforme, e cresce sob demanda.
 *
 * O dono reclamou das duas pontas: (1) o valor longo não dava para ler, e (2)
 * quando as células passaram a quebrar linha, as linhas ficaram altas demais e a
 * grade ficou ruim de visualizar. O comportamento fixado aqui é o do meio:
 *
 *  - a visão inicial é truncada, com todas as colunas do mesmo tamanho;
 *  - arrastar a borda do cabeçalho alarga/estreita a coluna;
 *  - arrastar a borda inferior da linha aumenta/diminui a altura da linha
 *    (aí sim o conteúdo quebra e aparece por inteiro);
 *  - os dois ajustes ficam guardados por tabela no `localStorage`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { TABELA, TABELA_PK_CRUA, DESCRICAO, LINHAS } = vi.hoisted(() => {
  const DESCRICAO = "descricao muito longa ".repeat(6).trim();
  const base = {
    schema: "public",
    tipo: "tabela" as const,
    colunas: [],
    estimativaLinhas: 3,
  };
  return {
    DESCRICAO,
    TABELA: { ...base, nome: "pedidos", chavePrimaria: ["id"] },
    // Reproduz o defeito de produção: a introspecção devolvia a PK como o
    // literal cru `"{id}"` (string), e o cliente quebrava ao iterar.
    TABELA_PK_CRUA: { ...base, nome: "legado", chavePrimaria: "{id}" as unknown as string[] },
    LINHAS: [{ id: 1, descricao: DESCRICAO }],
  };
});

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

vi.mock("@/hooks/external-db/useCatalogoExterno", () => ({
  useCatalogoExterno: () => ({
    data: [TABELA, TABELA_PK_CRUA],
    isLoading: false,
    isError: false,
    isSuccess: true,
  }),
}));

vi.mock("@/hooks/external-db/useDadosExternos", () => ({
  useDadosExternos: () => ({
    data: { colunas: ["id", "descricao"], linhas: LINHAS },
    isLoading: false,
    isError: false,
  }),
}));

import { ExploradorDeDados } from "./ExploradorDeDados";

const CHAVE_LARGURAS = "external-db:conn-1:public.pedidos:larguras";
const CHAVE_ALTURAS = "external-db:conn-1:public.pedidos:alturas";

function larguraDaColuna(indice: number): number {
  const coluna = document.querySelectorAll("col")[indice];
  if (!coluna) throw new Error(`coluna ${indice} não renderizou`);
  return Number.parseInt((coluna as HTMLElement).style.width, 10);
}

function alcaDeColuna(indice: number): HTMLElement {
  const alca = screen.getAllByRole("separator", { name: "Ajustar largura da coluna" })[indice];
  if (!alca) throw new Error(`alça da coluna ${indice} não renderizou`);
  return alca;
}

function alcaDaLinha(indice: number): HTMLElement {
  const alca = screen.getAllByRole("separator", { name: "Ajustar altura da linha" })[indice];
  if (!alca) throw new Error(`alça da linha ${indice} não renderizou`);
  return alca;
}

async function abrirGrade() {
  render(<ExploradorDeDados connectionId="conn-1" />);
  await userEvent.click(screen.getByRole("button", { name: "pedidos" }));
  await screen.findByText(DESCRICAO);
}

beforeEach(() => {
  window.localStorage.clear();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});

describe("ExploradorDeDados — visão compacta e redimensionável", () => {
  it("começa compacta: valor truncado numa linha, sem alongar a célula", async () => {
    await abrirGrade();
    expect(screen.getByText("descricao")).toBeInTheDocument();
    const celulaLonga = screen.getByText(DESCRICAO);
    expect(celulaLonga.className).toContain("truncate");
    expect(celulaLonga.className).not.toContain("whitespace-pre-wrap");
  });

  it("não quebra quando a PK chega crua (string) em vez de lista", async () => {
    render(<ExploradorDeDados connectionId="conn-1" />);
    await userEvent.click(screen.getByRole("button", { name: "legado" }));
    expect(await screen.findByText(DESCRICAO)).toBeInTheDocument();
  });

  it("alarga a coluna pela seta do teclado na alça de redimensionamento", async () => {
    await abrirGrade();
    const antes = larguraDaColuna(1);
    alcaDeColuna(1).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(larguraDaColuna(1)).toBe(antes + 24);
  });

  it("alarga a coluna arrastando a borda do cabeçalho, como numa planilha", async () => {
    await abrirGrade();
    const antes = larguraDaColuna(1);
    fireEvent.pointerDown(alcaDeColuna(1), { button: 0, clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 260 });
    fireEvent.pointerUp(document, { clientX: 260 });
    expect(larguraDaColuna(1)).toBe(antes + 60);
  });

  it("aumenta a altura da linha arrastando a borda inferior e mostra o conteúdo quebrado", async () => {
    await abrirGrade();
    fireEvent.pointerDown(alcaDaLinha(0), { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientY: 160 });
    fireEvent.pointerUp(document, { clientY: 160 });

    const celulaLonga = screen.getByText(DESCRICAO);
    expect(celulaLonga.style.height).toBe("92px");
    expect(celulaLonga.className).toContain("whitespace-pre-wrap");
    expect(window.localStorage.getItem(CHAVE_ALTURAS)).toBeTruthy();
  });

  it("guarda os ajustes de largura e altura por tabela no navegador", async () => {
    await abrirGrade();
    alcaDeColuna(1).focus();
    await userEvent.keyboard("{ArrowRight}");
    fireEvent.pointerDown(alcaDaLinha(0), { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(document, { clientY: 120 });
    fireEvent.pointerUp(document, { clientY: 120 });

    expect(window.localStorage.getItem(CHAVE_LARGURAS)).toBeTruthy();
    expect(window.localStorage.getItem(CHAVE_ALTURAS)).toBeTruthy();
  });
});
