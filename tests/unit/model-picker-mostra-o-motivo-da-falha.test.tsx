import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ModelPicker, type Provider } from "@/app/app/ai/agents/[id]/_components/ModelPicker";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

/**
 * A FALHA DA LISTAGEM APARECE NA TELA (#2602, #2622).
 *
 * O seletor fazia `query.data ?? []` e nunca lia o erro: com a listagem da
 * assinatura falhando, o operador via só o campo livre, e o motivo (502) ou o
 * "conecte a assinatura" (409) ficavam na aba de rede.
 */
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn() },
}));

function renderizar(provider: Provider) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ModelPicker id="model" provider={provider} value="" onChange={() => {}} />
    </QueryClientProvider>,
  );
}

describe("seletor de modelo mostra por que a lista não veio", () => {
  it("502 da assinatura: mostra que a conta segue conectada e o motivo, e mantém o campo livre", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(
      new ApiError(502, "internal_error", { motivo: "http_403" }, "req-1", "frase do servidor"),
    );
    renderizar("openai-assinatura");

    const aviso = await screen.findByRole("alert");
    expect(aviso.textContent).toContain("A conta continua conectada");
    expect(aviso.textContent).toContain("(http_403)");
    expect(screen.getByRole("textbox", { name: "Modelo" })).toBeTruthy();
  });

  it("409 da assinatura: pede para conectar em IA › Credenciais", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(
      new ApiError(409, "credential_invalid", undefined, "req-2", "frase do servidor"),
    );
    renderizar("openai-assinatura");

    const aviso = await screen.findByRole("alert");
    expect(aviso.textContent).toContain("Conecte a assinatura do ChatGPT em IA › Credenciais");
  });

  it("falha de outro provedor: avisa sem falar de assinatura", async () => {
    vi.mocked(apiClient.get).mockRejectedValue(
      new ApiError(500, "internal_error", undefined, "req-3", "Erro ao listar modelos."),
    );
    renderizar("openrouter");

    const aviso = await screen.findByRole("alert");
    expect(aviso.textContent).toContain("Não consegui carregar a lista de modelos");
    expect(aviso.textContent).not.toContain("assinatura");
  });

  it("lista vazia sem erro não mostra aviso", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ data: { models: [] } });
    renderizar("openrouter");

    await screen.findByRole("textbox", { name: "Modelo" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
