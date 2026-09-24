/**
 * A tela do catálogo agora é por COLUNA, com 4 checkboxes independentes
 * (IA, Critério, Mostrar, Comparar) + Ordem, e escolhas de Nome/Foto/Similares.
 * Este teste fixa:
 *  1. todas as colunas da tabela aparecem (inclusive as sem papel, ex.: `marca`);
 *  2. um mapeamento ANTIGO (só com papéis) é lido e convertido para os checkboxes;
 *  3. um mapeamento NOVO nasce com o essencial marcado;
 *  4. o Salvar envia `colunas` (config por coluna) e `col_similares`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mutate, DTO_ANTIGO } = vi.hoisted(() => ({
  mutate: vi.fn(),
  DTO_ANTIGO: {
    connection_id: "c1",
    schema_name: "public",
    table_name: "motos",
    col_nome: "nome",
    col_versao: "versao",
    col_ano: "ano",
    col_cor: "cor",
    col_km: "quilometragem",
    col_preco: "preco",
    col_imagem: "imagem_url",
    col_estoque: "estoque",
    col_cilindrada: "cilindrada",
    col_tipo: "categoria",
    busca_operador: "contem",
    enabled: true,
    similaridade_deterministica: true,
    similares_qtd: 3,
    ordem: { nome: 1, versao: 1, cilindrada: 2, preco: 3 },
    legenda: ["ano", "cor", "preco", "marca"],
    colunas: [],
    col_similares: null,
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

// O mapeamento devolvido é trocável por teste (antigo vs. novo).
let dtoAtual: unknown = DTO_ANTIGO;
vi.mock("@/hooks/external-db/useCatalogoMapeamento", () => ({
  useCatalogoMapeamento: () => ({ data: dtoAtual, isLoading: false, isError: false }),
  useSalvarCatalogoMapeamento: () => ({ mutate, isPending: false }),
}));

import { toast } from "sonner";

import { ConfigurarCatalogo } from "./ConfigurarCatalogo";

const COLUNAS = [
  "id",
  "nome",
  "marca",
  "versao",
  "categoria",
  "ano",
  "cor",
  "preco",
  "quilometragem",
  "cilindrada",
  "potencia",
  "descricao",
  "imagem_url",
  "tipo_combustivel",
  "cambio",
  "estoque",
  "moto_similar",
  "preco_de_tabela_fipe",
];

const TABELA = {
  schema: "public",
  nome: "motos",
  colunas: COLUNAS.map((nome) => ({ nome })),
};

function abrir() {
  render(
    <ConfigurarCatalogo connectionId="c1" tabela={TABELA} aberto aoMudarAberto={vi.fn()} />,
  );
}

/** O contêiner da grade (evita casar com o texto de ajuda). */
function grade(): HTMLElement {
  const cabecalho = screen.getByText("Coluna");
  const container = cabecalho.parentElement?.parentElement;
  if (!container) throw new Error("grade do catálogo não encontrada");
  return container;
}

function linhaDe(coluna: string): HTMLElement {
  const celula = within(grade()).getByText(coluna);
  const linha = celula.closest("div");
  if (!linha) throw new Error(`linha de ${coluna} não encontrada`);
  return linha;
}

/** [ia, criterio, mostrar, comparar] da linha. */
function caixas(coluna: string): boolean[] {
  return within(linhaDe(coluna))
    .getAllByRole("checkbox")
    .map((c) => (c as HTMLInputElement).checked);
}

describe("ConfigurarCatalogo — configuração por coluna", () => {
  beforeEach(() => {
    dtoAtual = DTO_ANTIGO;
    mutate.mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    // Radix Select usa Pointer Capture (não existe no jsdom).
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
    window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("mostra TODAS as colunas da tabela, inclusive as sem papel (marca)", () => {
    abrir();
    for (const coluna of COLUNAS) {
      expect(within(grade()).getByText(coluna)).toBeInTheDocument();
    }
  });

  it("converte um mapeamento ANTIGO (papéis) para os checkboxes", () => {
    abrir();
    // legenda antiga tinha `marca` → Mostrar marcado.
    expect(caixas("marca")).toEqual([true, true, true, false]);
    // `preco` era papel de comparação → Comparar marcado.
    expect(caixas("preco")).toEqual([true, true, true, true]);
    // `cilindrada` era papel de comparação → Comparar marcado.
    expect(caixas("cilindrada")).toEqual([true, true, false, true]);
  });

  it("mapeamento NOVO nasce com o essencial marcado", () => {
    dtoAtual = null;
    abrir();
    expect(caixas("preco")).toEqual([true, true, true, true]);
    expect(caixas("descricao")).toEqual([false, false, false, false]);
    expect(caixas("id")).toEqual([false, false, false, false]);
  });

  it("salva enviando `colunas` e `col_similares`", async () => {
    dtoAtual = null;
    abrir();
    // Liga a referência de similares e escolhe a coluna.
    await userEvent.click(screen.getByLabelText("Motos similares (referência)"));
    await userEvent.click(screen.getAllByRole("combobox")[2]!);
    await userEvent.click(await screen.findByRole("option", { name: "moto_similar" }));

    await userEvent.click(screen.getByRole("button", { name: /salvar catálogo/i }));

    expect(toast.error).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(1);
    const body = mutate.mock.calls[0]![0];
    expect(body.col_nome).toBe("nome");
    expect(body.col_similares).toBe("moto_similar");
    const preco = body.colunas.find((c: { coluna: string }) => c.coluna === "preco");
    expect(preco).toMatchObject({ ia: true, criterio: true, mostrar: true, comparar: true });
    const descricao = body.colunas.find((c: { coluna: string }) => c.coluna === "descricao");
    expect(descricao).toMatchObject({ ia: false, criterio: false, mostrar: false, comparar: false });
  });
});
