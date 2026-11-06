/**
 * O SELETOR DE MODELO: BUSCA, PREÇO NO "$" E O MODELO QUE JÁ ESTAVA SALVO.
 *
 * Quem escolhe modelo escolhe entre centenas (a OpenRouter lista 400+):
 * sem busca, a lista é rolagem; sem preço, o leigo só descobre o custo na
 * fatura. A lista que chega aqui já vem sem `:batch` (a rota filtra, ver
 * `models/route.test.ts`), mas um agente pode ter o id salvo de antes — e o
 * gatilho não pode ficar em branco nem calar sobre o motivo de ele falhar.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { ModelPicker, type ModelOption } from "./ModelPicker";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));

const CATALOGO: ModelOption[] = [
  {
    provider: "openrouter",
    model_id: "deepseek/deepseek-v4.1-flash",
    display_name: "DeepSeek: DeepSeek V4.1 Flash",
    context_window: 1_048_576,
    is_default_for_provider: false,
    input_price_per_million_cents: 5,
    output_price_per_million_cents: 50,
  },
  {
    provider: "openrouter",
    model_id: "openai/gpt-6-luna",
    display_name: "OpenAI: GPT-6 Luna",
    context_window: 1_050_000,
    is_default_for_provider: false,
    input_price_per_million_cents: 10,
    output_price_per_million_cents: 50,
  },
  {
    provider: "openrouter",
    model_id: "acme/sem-preco",
    display_name: "Acme: Sem Preço",
    context_window: null,
    is_default_for_provider: false,
    input_price_per_million_cents: null,
    output_price_per_million_cents: null,
  },
  {
    provider: "openrouter",
    model_id: "acme/de-graca:free",
    display_name: "Acme: De Graça",
    context_window: null,
    is_default_for_provider: false,
    input_price_per_million_cents: 0,
    output_price_per_million_cents: 0,
  },
];

function montar(value: string, onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ModelPicker provider="openrouter" value={value} onChange={onChange} id="modelo" />
    </QueryClientProvider>,
  );
  return onChange;
}

async function abrir() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox"));
  return user;
}

describe("ModelPicker — busca, preço e modelo salvo", () => {
  beforeEach(() => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { models: CATALOGO } } as never);
  });

  it("filtra a lista pelo que a pessoa digita, sem ligar para caixa nem acento", async () => {
    montar("");
    const user = await abrir();
    expect(screen.getAllByRole("option")).toHaveLength(4);

    await user.type(screen.getByRole("textbox", { name: "Buscar modelo" }), "LUNA");

    const opcoes = screen.getAllByRole("option");
    expect(opcoes).toHaveLength(1);
    expect(opcoes[0]).toHaveTextContent("OpenAI: GPT-6 Luna");
  });

  it("acha pelo identificador também, não só pelo nome de exibição", async () => {
    montar("");
    const user = await abrir();

    await user.type(screen.getByRole("textbox", { name: "Buscar modelo" }), "deepseek-v4");

    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("diz quando nada casa, em vez de uma lista em branco", async () => {
    montar("");
    const user = await abrir();

    await user.type(screen.getByRole("textbox", { name: "Buscar modelo" }), "zzzz");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nenhum modelo encontrado")).toBeInTheDocument();
  });

  it("Enter na busca escolhe o primeiro resultado e fecha a lista", async () => {
    const onChange = montar("");
    const user = await abrir();

    await user.type(screen.getByRole("textbox", { name: "Buscar modelo" }), "luna{Enter}");

    expect(onChange).toHaveBeenCalledWith("openai/gpt-6-luna", { contextWindow: 1_050_000 });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("o '$' de cada modelo traz entrada e saída por milhão, em dólares", async () => {
    montar("");
    await abrir();

    const luna = screen
      .getAllByRole("option")
      .find((o) => within(o).queryByText(/GPT-6 Luna/))!;
    const icone = within(luna).getByTestId("preco-do-modelo");

    const rotulo = (icone.getAttribute("aria-label") ?? "").replace(/ /g, " ");
    expect(rotulo).toContain("Preço por 1 milhão de tokens");
    expect(rotulo).toContain("Entrada US$ 0,10");
    expect(rotulo).toContain("Saída US$ 0,50");
  });

  it("passar o cursor sobre o '$' mostra o custo", async () => {
    montar("");
    const user = await abrir();
    const luna = screen
      .getAllByRole("option")
      .find((o) => within(o).queryByText(/GPT-6 Luna/))!;

    await user.hover(within(luna).getByTestId("preco-do-modelo"));

    const balao = await screen.findByRole("tooltip");
    expect(balao.textContent?.replace(/ /g, " ")).toMatch(/Entrada: US\$ 0,10/);
    expect(balao.textContent?.replace(/ /g, " ")).toMatch(/Saída: US\$ 0,50/);
  });

  it("preço desconhecido diz 'não informado' e zero diz 'Grátis' — não se confundem", async () => {
    montar("");
    await abrir();
    const opcoes = screen.getAllByRole("option");
    const rotuloDe = (nome: RegExp) =>
      within(opcoes.find((o) => within(o).queryByText(nome))!)
        .getByTestId("preco-do-modelo")
        .getAttribute("aria-label");

    expect(rotuloDe(/Sem Preço/)).toContain("Preço não informado");
    expect(rotuloDe(/Sem Preço/)).not.toContain("Grátis");
    expect(rotuloDe(/De Graça/)).toContain("Grátis");
  });

  it("modelo salvo que a lista não oferece (:batch) continua visível e avisa o porquê", async () => {
    montar("openai/gpt-6-luna:batch");

    const gatilho = await screen.findByRole("combobox");
    await waitFor(() => expect(gatilho).toHaveTextContent("openai/gpt-6-luna:batch"));
    expect(screen.getByRole("alert")).toHaveTextContent(/variante de lote e não responde no chat/);
  });

  it("modelo normal salvo não dispara o aviso de lote", async () => {
    montar("openai/gpt-6-luna");

    const gatilho = await screen.findByRole("combobox");
    // Primeiro "Carregando…" (nunca o id cru), depois o nome de exibição.
    expect(gatilho).toHaveTextContent("Carregando…");
    await waitFor(() => expect(gatilho).toHaveTextContent("OpenAI: GPT-6 Luna"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
