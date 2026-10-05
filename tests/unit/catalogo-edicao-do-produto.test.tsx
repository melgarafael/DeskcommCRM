import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn(), patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
// A tradução não é o assunto deste arquivo: a chave em português é o texto.
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { ProdutosClient } from "@/app/app/products/_client";
import { apiClient } from "@/lib/api/client";
import {
  corpoDaEdicao,
  rascunhoDaEdicao,
  sincronizadoDeOrigem,
} from "@/lib/catalogo/edicao-do-produto";
import type { Produto } from "@/lib/schemas/produtos";
import { toast } from "sonner";

/**
 * EDITAR O PRODUTO PELA TELA — a régua e o botão.
 *
 * Três coisas são o assunto aqui, e nenhuma delas é cosmética:
 *
 *  1. O PATCH é parcial: o corpo leva SÓ o que mudou. Mandar o formulário
 *     inteiro regrava `updated_at` e audita uma mutação que não houve.
 *  2. `origem` externa não se edita aqui: a próxima sincronização sobrescreve,
 *     então a tela abre somente leitura com o aviso de que o lugar de editar
 *     é a origem (fotos seguem livres — a integração não mexe nelas).
 *  3. A lista acompanha o volume: 550 produtos renderizam e o 501º se edita.
 *     O corte de 500 é da QUERY da página (parte 1 da issue #2135, PR #2138);
 *     o componente não tem teto nenhum, e é isto que este caso prova.
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

function tela(produtos: Produto[], podeEditar = true) {
  return render(
    <ProdutosClient
      inicial={produtos}
      total={produtos.length}
      pagina={1}
      porPagina={produtos.length}
      buscaInicial=""
      urlsDasFotos={{}}
      podeEditar={podeEditar}
      textos={TEXTOS}
    />,
  );
}

const semIdioma = (s: string) => s;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("o corpo do PATCH leva só o que mudou", () => {
  it("preço novo entra sozinho, o resto fica de fora", () => {
    const p = produto();
    const rascunho = { ...rascunhoDaEdicao(p), preco: "299,90" };
    expect(corpoDaEdicao(rascunho, p, semIdioma)).toEqual({ corpo: { preco_cents: 29990 } });
  });

  it("texto que não dá pra ler como preço é recusado antes do servidor", () => {
    const p = produto();
    const rascunho = { ...rascunhoDaEdicao(p), preco: "abc" };
    const { corpo, erro } = corpoDaEdicao(rascunho, p, semIdioma);
    expect(corpo).toEqual({});
    expect(erro).toBe("Preço inválido. Escreva assim: 5.499,00");
  });

  it('nada mudou é corpo vazio — a rota devolveria 422 "Nada para alterar."', () => {
    const p = produto({ descricao: 'Tela 6,1"', marca: "Apple", custo_cents: 10000 });
    expect(corpoDaEdicao(rascunhoDaEdicao(p), p, semIdioma)).toEqual({ corpo: {} });
  });

  it("limpar uma campo é mudança (e vira string vazia, não some da comparação)", () => {
    const p = produto({ categoria: "Celular" });
    const rascunho = { ...rascunhoDaEdicao(p), categoria: "" };
    expect(corpoDaEdicao(rascunho, p, semIdioma)).toEqual({ corpo: { categoria: "" } });
  });
});

describe("origem externa não se edita aqui", () => {
  it("manual e planilha são do CRM; nuvemshop e origem desconhecida são da integração", () => {
    expect(sincronizadoDeOrigem("manual")).toBe(false);
    expect(sincronizadoDeOrigem("planilha")).toBe(false);
    // Linha antiga sem origem: não indica fonte nenhuma, e trancar catálogo
    // legado por campo em branco seria pior que deixar editar.
    expect(sincronizadoDeOrigem("")).toBe(false);
    expect(sincronizadoDeOrigem("nuvemshop")).toBe(true);
    expect(sincronizadoDeOrigem("mercado_livre")).toBe(true);
  });
});

describe("o botão Editar", () => {
  it("abre preenchido com a linha e grava só o preço que mudou", async () => {
    const p = produto();
    tela([p]);

    fireEvent.click(screen.getByTestId("editar-IP15"));
    expect((screen.getByTestId("edicao-preco") as HTMLInputElement).value).toBe("249,90");

    fireEvent.change(screen.getByTestId("edicao-preco"), { target: { value: "299,90" } });
    fireEvent.click(screen.getByTestId("salvar-edicao"));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith(`/api/v1/products/${p.id}`, {
        preco_cents: 29990,
      }),
    );
    expect(apiClient.patch).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Produto atualizado");
  });

  it("produto sincronizado abre somente leitura, com o aviso da origem", () => {
    tela([produto({ origem: "nuvemshop" })]);

    fireEvent.click(screen.getByTestId("editar-IP15"));

    expect(screen.getByTestId("aviso-sincronizado").textContent).toContain("nuvemshop");
    expect((screen.getByTestId("edicao-preco") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("edicao-nome") as HTMLInputElement).disabled).toBe(true);
    // Sem botão de salvar não existe caminho para gravar pela API.
    expect(screen.queryByTestId("salvar-edicao")).toBeNull();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("sem mudança nenhuma não chama a API", async () => {
    tela([produto()]);

    fireEvent.click(screen.getByTestId("editar-IP15"));
    fireEvent.click(screen.getByTestId("salvar-edicao"));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nada para alterar."));
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it("550 produtos: a lista renderiza todos e o 501º edita", async () => {
    const catalogo = Array.from({ length: 550 }, (_, i) =>
      produto({
        id: `p${i + 1}`,
        codigo: `P${i + 1}`,
        nome: `Produto ${i + 1}`,
        preco_cents: 1000 * (i + 1),
      }),
    );
    const { container } = tela(catalogo);

    expect(container.querySelectorAll('[data-testid^="produto-"]').length).toBe(550);
    expect(screen.getByText("Produto 550")).toBeTruthy();

    fireEvent.click(screen.getByTestId("editar-P550"));
    fireEvent.change(screen.getByTestId("edicao-preco"), { target: { value: "10,00" } });
    fireEvent.click(screen.getByTestId("salvar-edicao"));

    await waitFor(() =>
      expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/products/p550", { preco_cents: 1000 }),
    );
  });
});
