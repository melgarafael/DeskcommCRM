import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const get = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiClient: { get },
}));

import { ModelPicker, type ModelOption } from "@/app/app/ai/agents/[id]/_components/ModelPicker";

const MODELOS: ModelOption[] = [
  {
    provider: "anthropic",
    model_id: "claude-sonnet-4-6",
    display_name: "Claude Sonnet 4.6",
    context_window: 200000,
    is_default_for_provider: false,
  },
  {
    provider: "anthropic",
    model_id: "claude-haiku-4-5",
    display_name: "Claude Haiku 4.5",
    context_window: 200000,
    is_default_for_provider: false,
  },
];

function montar(
  extra: Partial<ComponentProps<typeof ModelPicker>> = {},
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  render(
    <QueryClientProvider client={qc}>
      <ModelPicker provider="anthropic" value="" onChange={() => undefined} {...extra} />
    </QueryClientProvider>,
  );
  return qc;
}

describe("ModelPicker diferencia loading, erro e catálogo vazio", () => {
  beforeEach(() => {
    get.mockReset();
  });

  it("com catálogo do servidor não pinta vazio nem busca de novo", () => {
    montar({ modelsFromServer: MODELOS });
    expect(screen.queryByText("O catálogo deste provedor está vazio.")).not.toBeInTheDocument();
    expect(screen.queryByText("Não consegui carregar os modelos.")).not.toBeInTheDocument();
    expect(screen.queryByText("Nenhum modelo disponível")).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("enquanto carrega não afirma que o catálogo está vazio", () => {
    get.mockImplementation(() => new Promise(() => undefined));
    montar();
    expect(screen.getByTestId("model-picker-status")).toHaveTextContent("Carregando…");
    expect(screen.queryByText("O catálogo deste provedor está vazio.")).not.toBeInTheDocument();
    expect(screen.queryByText("Nenhum modelo disponível")).not.toBeInTheDocument();
  });

  it("timeout ou erro ganha mensagem própria e botão de retry", async () => {
    get.mockRejectedValueOnce(new Error("timeout"));
    montar();
    await waitFor(() =>
      expect(screen.getByTestId("model-picker-status")).toHaveTextContent(
        "Não consegui carregar os modelos.",
      ),
    );
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
    expect(screen.queryByText("O catálogo deste provedor está vazio.")).not.toBeInTheDocument();
  });

  it("retry recupera a lista depois do erro", async () => {
    get
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ data: { models: MODELOS } });
    montar();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Tentar novamente" })).not.toBeInTheDocument(),
    );
  });

  it("catálogo realmente vazio não se mistura com erro", async () => {
    get.mockResolvedValueOnce({ data: { models: [] } });
    montar();
    expect(await screen.findByText("O catálogo deste provedor está vazio.")).toBeInTheDocument();
    expect(screen.queryByText("Não consegui carregar os modelos.")).not.toBeInTheDocument();
  });
});
