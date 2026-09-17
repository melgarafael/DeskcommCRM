import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ModelPicker } from "@/app/app/ai/agents/[id]/_components/ModelPicker";

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({ data: { models: [] } })),
  },
}));

describe("seletor de modelo do agente", () => {
  it("aceita o identificador manual quando o catálogo do provedor está vazio", async () => {
    const onChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    function SeletorControlado() {
      const [model, setModel] = useState("");
      return (
        <ModelPicker
          id="model"
          provider="openrouter"
          value={model}
          onChange={(modelId, context) => {
            setModel(modelId);
            onChange(modelId, context);
          }}
        />
      );
    }

    render(
      <QueryClientProvider client={client}>
        <SeletorControlado />
      </QueryClientProvider>,
    );

    const campo = await screen.findByRole("textbox", { name: "Modelo" });
    await userEvent.type(campo, "inclusionai/ling-3.0-flash-fin:free");

    expect(onChange).toHaveBeenLastCalledWith("inclusionai/ling-3.0-flash-fin:free", {
      contextWindow: null,
    });
  });
});
