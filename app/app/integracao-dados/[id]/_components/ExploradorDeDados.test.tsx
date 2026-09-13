/**
 * A grade do banco externo precisa deixar LER o que está na célula.
 *
 * O defeito relatado pelo dono: colunas com largura fixa e `truncate` escondiam
 * valores longos (JSON, texto, observação) sem qualquer forma de alargar. Este
 * teste fixa o comportamento da correção: o valor sempre aparece inteiro (com
 * quebra de linha), a coluna se alarga arrastando a borda (aqui também pelo
 * teclado, que é o caminho determinístico) e a largura fica guardada por tabela
 * no `localStorage`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { TABELA, DESCRICAO, LINHAS } = vi.hoisted(() => {
  const DESCRICAO = "descricao muito longa ".repeat(6).trim();
  return {
    DESCRICAO,
    TABELA: {
      schema: "public",
      nome: "pedidos",
      tipo: "tabela" as const,
      colunas: [],
      chavePrimaria: ["id"],
      estimativaLinhas: 3,
    },
    LINHAS: [{ id: 1, descricao: DESCRICAO }],
  };
});

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

vi.mock("@/hooks/external-db/useCatalogoExterno", () => ({
  useCatalogoExterno: () => ({
    data: [TABELA],
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

const CHAVE_LARGURAS = "external-db:larguras:conn-1:public.pedidos";

function larguraDaColuna(indice: number): number {
  const coluna = document.querySelectorAll("col")[indice];
  if (!coluna) throw new Error(`coluna ${indice} não renderizou`);
  return Number.parseInt((coluna as HTMLElement).style.width, 10);
}

function alcaDaColuna(indice: number): HTMLElement {
  const alca = screen.getAllByRole("separator")[indice];
  if (!alca) throw new Error(`alça da coluna ${indice} não renderizou`);
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

describe("ExploradorDeDados — leitura do conteúdo", () => {
  it("mostra os nomes das colunas e o conteúdo por extenso das células", async () => {
    await abrirGrade();
    expect(screen.getByText("descricao")).toBeInTheDocument();
    expect(screen.getByText(DESCRICAO)).toBeInTheDocument();
  });

  it("alarga a coluna pela seta do teclado na alça de redimensionamento", async () => {
    await abrirGrade();
    const antes = larguraDaColuna(1);
    alcaDaColuna(1).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(larguraDaColuna(1)).toBe(antes + 24);
  });

  it("mostra o valor inteiro com quebra de linha, sem cortar com reticências", async () => {
    await abrirGrade();
    const celulaLonga = screen.getByText(DESCRICAO);
    expect(celulaLonga.className).toContain("whitespace-pre-wrap");
    expect(celulaLonga.className).not.toContain("truncate");
  });

  it("alarga a coluna arrastando a borda do cabeçalho, como numa planilha", async () => {
    await abrirGrade();
    const antes = larguraDaColuna(1);
    fireEvent.pointerDown(alcaDaColuna(1), { button: 0, clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 260 });
    fireEvent.pointerUp(document, { clientX: 260 });
    expect(larguraDaColuna(1)).toBe(antes + 60);
  });

  it("guarda a largura arrastada por tabela no navegador", async () => {
    await abrirGrade();
    fireEvent.pointerDown(alcaDaColuna(1), { button: 0, clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(document, { clientX: 220 });
    fireEvent.pointerUp(document, { clientX: 220 });
    expect(window.localStorage.getItem(CHAVE_LARGURAS)).toBeTruthy();
  });
});
