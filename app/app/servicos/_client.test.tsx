/**
 * A TELA DO CATÁLOGO DE SERVIÇOS (#3480, fatia 2) chama as rotas com o corpo
 * que elas aceitam.
 *
 * O contrato é o de `lib/schemas/servicos.ts`: o create manda tipo e unidade; a
 * edição manda `expected_revision` e APAGA prazo e sinal com `null` (ausente
 * não apaga); a variação manda só nome, código, preço e `pai_id`. Um corpo
 * fora disso a rota recusa com 422 — e a pessoa leria "não passou nas regras"
 * por um defeito da tela.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServicoMontado } from "@/lib/catalogo/servicos";

import { ServicosClient } from "./_client";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CONSULTORIA: ServicoMontado = {
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "CONS",
  nome: "Consultoria",
  descricao: null,
  tipo: "projeto",
  unidade: "valor_fechado",
  prazo_dias_uteis: 10,
  preco_a_partir_cents: 350000,
  preco_a_partir: "R$ 3.500,00",
  sinal: { tipo: "percentual", valor: 30, cents: 105000, rotulo: "sinal de R$ 1.050,00 (30%)" },
  variacoes: [],
  ativo: true,
  fotos: null,
  instrucoes_ia: null,
  ia_oferece: true,
  revision: 3,
};

function montar(lista: ServicoMontado[], podeEditar = true) {
  api.get.mockResolvedValue({ data: lista, meta: { pagina: 1, has_more: false } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ServicosClient podeEditar={podeEditar} moeda="BRL" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset().mockResolvedValue({ data: {} });
  api.patch.mockReset().mockResolvedValue({ data: {} });
});

describe("catálogo de serviços — a tela", () => {
  it("lista o que a rota devolve, com o preço na moeda da organização", async () => {
    montar([CONSULTORIA]);
    const item = await screen.findByTestId("servico");
    expect(api.get).toHaveBeenCalledWith("/api/v1/servicos?pagina=1");
    expect(within(item).getByText(/Consultoria/)).toBeInTheDocument();
    expect(item.textContent).toContain("10 dias úteis");
    expect(item.textContent).toMatch(/sinal de R\$\s1\.050,00 \(30%\)/);
  });

  it("sem serviço, mostra o estado vazio — e não uma lista em branco", async () => {
    montar([]);
    expect(await screen.findByTestId("servicos-vazio")).toBeInTheDocument();
    expect(screen.getByText("Nenhum serviço cadastrado ainda")).toBeInTheDocument();
  });

  it("erro da rota vira aviso com 'Tentar de novo', não 'nenhum serviço'", async () => {
    api.get.mockRejectedValue(new Error("500"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ServicosClient podeEditar moeda="BRL" />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Não consegui carregar os serviços.");
    expect(screen.queryByTestId("servicos-vazio")).toBeNull();
  });

  it("criar manda tipo, unidade, preço em centavos e o sinal — e nada do que ficou vazio", async () => {
    montar([]);
    fireEvent.click(await screen.findByRole("button", { name: "Novo serviço" }));
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Social media" } });
    fireEvent.change(screen.getByLabelText("Código"), { target: { value: "SM" } });
    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "recorrente" } });
    // Trocar o tipo leva a unidade para a família dele (recorrente → mês).
    expect(screen.getByLabelText("Cobrança")).toHaveValue("mes");
    fireEvent.change(screen.getByLabelText("Preço"), { target: { value: "1.200,00" } });
    fireEvent.change(screen.getByLabelText("Sinal"), { target: { value: "fixo" } });
    fireEvent.change(screen.getByLabelText("Valor do sinal"), { target: { value: "300,00" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith("/api/v1/servicos", {
      codigo: "SM",
      nome: "Social media",
      tipo: "recorrente",
      unidade: "mes",
      ia_oferece: true,
      preco_cents: 120000,
      sinal: { tipo: "fixo", valor: 30000 },
    });
  });

  it("editar manda a revisão vista e apaga prazo e sinal com null", async () => {
    montar([CONSULTORIA]);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    expect(screen.getByLabelText("Preço")).toHaveValue("3.500,00");
    fireEvent.change(screen.getByLabelText("Tipo"), { target: { value: "hora_marcada" } });
    fireEvent.change(screen.getByLabelText("Sinal"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith(`/api/v1/servicos/${CONSULTORIA.id}`, {
      codigo: "CONS",
      nome: "Consultoria",
      tipo: "hora_marcada",
      unidade: "sessao",
      ia_oferece: true,
      descricao: null,
      instrucoes_ia: null,
      prazo_dias_uteis: null,
      sinal: null,
      expected_revision: 3,
    });
  });

  it("com variações, a edição não grava o 'a partir de' como preço do principal", async () => {
    const comVariacao: ServicoMontado = {
      ...CONSULTORIA,
      preco_a_partir_cents: 90000,
      variacoes: [
        { id: "v1", codigo: "CONS-P", nome: "Pequena", preco_cents: 90000, preco: "", sinal_cents: null, sinal: null, ativo: true, fotos: null },
      ],
    };
    montar([comVariacao]);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    expect(screen.getByLabelText("Preço")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch.mock.calls[0]![1]).not.toHaveProperty("preco_cents");
  });

  it("a variação manda só pai_id, nome, código e preço", async () => {
    montar([CONSULTORIA]);
    fireEvent.click(await screen.findByRole("button", { name: "Nova variação" }));
    fireEvent.change(screen.getByLabelText("Nome da variação"), { target: { value: "Grande" } });
    fireEvent.change(screen.getByLabelText("Código da variação"), { target: { value: "CONS-G" } });
    fireEvent.change(screen.getByLabelText("Preço da variação"), { target: { value: "8.000,00" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar variação" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith("/api/v1/servicos", {
      pai_id: CONSULTORIA.id,
      nome: "Grande",
      codigo: "CONS-G",
      preco_cents: 800000,
    });
  });

  it("desativar é o PATCH do item do catálogo, com { ativo: false }", async () => {
    montar([CONSULTORIA]);
    fireEvent.click(await screen.findByRole("button", { name: "Desativar" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(`/api/v1/products/${CONSULTORIA.id}`, { ativo: false }));
  });

  it("sem papel de gerente, a tela lista mas não oferece escrita", async () => {
    montar([CONSULTORIA], false);
    await screen.findByTestId("servico");
    expect(screen.queryByRole("button", { name: "Novo serviço" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Desativar" })).toBeNull();
  });
});
