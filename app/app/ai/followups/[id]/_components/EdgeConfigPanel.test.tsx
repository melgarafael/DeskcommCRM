import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FlowNode } from "@/lib/followup/graph-schema";

import { EdgeConfigPanel } from "./EdgeConfigPanel";

const origem: FlowNode = {
  id: "t1",
  type: "trigger",
  label: "Início",
  position: { x: 0, y: 0 },
  config: {},
};

const destino: FlowNode = {
  id: "e1",
  type: "end",
  label: "Fim",
  position: { x: 200, y: 0 },
  config: { outcome: "exhausted" },
};

describe("EdgeConfigPanel — excluir aresta", () => {
  it("oferece Excluir aresta e dispara onDelete", async () => {
    const onDelete = vi.fn();
    render(
      <EdgeConfigPanel
        sourceNode={origem}
        targetNode={destino}
        condition={{ type: "always" }}
        onChange={() => {}}
        onDelete={onDelete}
      />,
    );

    const botao = screen.getByTestId("delete-edge");
    expect(botao).toHaveTextContent("Excluir aresta");
    await userEvent.setup({ delay: null }).click(botao);
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
