import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ModelPicker } from "@/app/app/ai/agents/[id]/_components/ModelPicker";

const modelo = (model_id: string, display_name: string, context_window = 200_000) => ({
  provider: "openrouter",
  model_id,
  display_name,
  context_window,
  is_default_for_provider: false,
});

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({
      data: {
        models: [
          modelo("anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6"),
          modelo("anthropic/claude-haiku-4-5", "Claude Haiku 4.5"),
          modelo("anthropic/claude-opus-4-7", "Claude Opus 4.7"),
          modelo("openai/gpt-5", "GPT-5", 400_000),
          modelo("openai/gpt-5-mini", "GPT-5 mini", 400_000),
          modelo("google/gemini-2.5-pro", "Gemini 2.5 Pro", 1_000_000),
          modelo("google/gemini-2.5-flash", "Gemini 2.5 Flash", 1_000_000),
          modelo("meta-llama/llama-3.3-70b-instruct", "Llama 3.3 70B", 128_000),
          modelo("mistralai/mistral-large", "Mistral Large", 128_000),
        ],
      },
    })),
  },
}));

describe("seletor de modelo do agente — busca", () => {
  it("acha o modelo digitando, sem rolar a lista", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function SeletorControlado() {
      const [model, setModel] = useState("");
      return (
        <ModelPicker
          id="model"
          provider="openrouter"
          value={model}
          onChange={(modelId, contexto) => {
            setModel(modelId);
            onChange(modelId, contexto);
          }}
        />
      );
    }

    render(
      <QueryClientProvider client={client}>
        <SeletorControlado />
      </QueryClientProvider>,
    );

    const gatilho = await screen.findByRole("combobox", { name: "Modelo" });
    await screen.findByText("Selecione um modelo");
    await user.click(gatilho);
    await user.type(await screen.findByRole("textbox", { name: "Buscar modelo…" }), "haiku");

    const opcoes = screen.getAllByRole("option");
    expect(opcoes.map((o) => o.textContent)).toEqual(["Claude Haiku 4.5"]);

    await user.click(opcoes[0]!);
    expect(onChange).toHaveBeenLastCalledWith("anthropic/claude-haiku-4-5", { contextWindow: 200_000 });
    expect(gatilho).toHaveTextContent("Claude Haiku 4.5");
  });
});
