/**
 * O botão de excluir mora na casca do painel, não em cada formulário — um
 * único lugar cobre os 8 tipos. O loop abaixo é a prova de que nenhum tipo
 * troca o painel por outra casca e perde o botão.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NODE_TYPES } from "@/lib/followup/graph-schema";
import type { RFNode } from "@/lib/followup/graph-mappers";

import { NodeConfigPanel } from "./NodeConfigPanel";
import { NODE_VISUALS } from "./nodes/nodeVisuals";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => false,
}));

function noDe(type: (typeof NODE_TYPES)[number]): RFNode {
  const visual = NODE_VISUALS[type];
  return {
    id: `${type}-1`,
    type,
    position: { x: 0, y: 0 },
    data: { label: visual.defaultLabel, config: visual.defaultConfig() },
  };
}

function montar(type: (typeof NODE_TYPES)[number], onDelete = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NodeConfigPanel node={noDe(type)} onChange={() => {}} onDelete={onDelete} />
    </QueryClientProvider>,
  );
  return onDelete;
}

describe("NodeConfigPanel — excluir nó", () => {
  it.each(NODE_TYPES)("oferece Excluir nó para o tipo %s e dispara onDelete", async (type) => {
    const onDelete = montar(type);
    const botao = screen.getByTestId("delete-node");
    expect(botao).toHaveTextContent("Excluir nó");
    await userEvent.setup({ delay: null }).click(botao);
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
