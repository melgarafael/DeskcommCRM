/**
 * A barra de publicação é o call-site do canvas: é ela quem segura o botão que
 * apaga o nó ou a aresta selecionada — no MESMO assento do irmão que apaga o
 * fluxo inteiro (mesmo ícone de lixeira, mesmo canto). Era essa simetria que
 * faltava (issue #700): um irmão perguntava, o outro não.
 *
 * O canvas (XYFlow) não renderiza em jsdom — depende de medição de DOM. A barra
 * renderiza, então o teste é de COMPORTAMENTO no ponto exato do contrato: até a
 * confirmação, `onDeleteSelection` não é chamado; depois dela, é chamado uma
 * vez; e o diálogo NOMEIA o alvo (nó × aresta), porque quem lê a confirmação
 * precisa saber o que vai embora antes de decidir.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FollowupFlowDetailRow } from "@/hooks/followup/useFollowupFlow";
import type { FlowGraph } from "@/lib/followup/graph-schema";

import { PublishBar } from "./PublishBar";

// As mutações da barra não participam do fluxo testado — excluir a seleção é
// callback do canvas (estado local), não request. Mutação inerte, sem QueryClient.
vi.mock("@/hooks/followup/useFollowupFlow", () => {
  const mutacao = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useDeleteFollowupFlow: mutacao,
    useDisableFollowupFlow: mutacao,
    usePublishFollowupFlow: mutacao,
    useRollbackFollowupFlow: mutacao,
    useSaveFollowupFlowDraft: mutacao,
    useUpdateHandoffPolicy: mutacao,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("./TriggerConfigControl", () => ({ TriggerConfigControl: () => null }));

const FLUXO: FollowupFlowDetailRow = {
  id: "fluxo-1",
  name: "Boas-vindas",
  status: "draft",
  active_version_id: null,
  draft_graph: null,
  handoff_policy: "pause",
  trigger_config: {},
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
  versions_count: 1,
  previous_version_id: null,
};

const GRAFO: FlowGraph = { nodes: [], edges: [] };

function montar(selection: "node" | "edge" | null) {
  const onDeleteSelection = vi.fn();
  render(
    <PublishBar
      flowId="fluxo-1"
      flow={FLUXO}
      graph={GRAFO}
      dirty={false}
      selection={selection}
      onDeleteSelection={onDeleteSelection}
      onSaved={() => {}}
      onPublishErrors={() => {}}
      onPublishSuccess={() => {}}
      canAutoFit={false}
    />,
  );
  return onDeleteSelection;
}

function usuario() {
  return userEvent.setup({ delay: null });
}

describe("PublishBar — excluir a seleção pede confirmação", () => {
  it("clicar em Excluir nó não exclui nada, só abre a confirmação", async () => {
    const onDeleteSelection = montar("node");

    await usuario().click(screen.getByTestId("delete-selection"));

    const dialogo = await screen.findByRole("alertdialog");
    expect(dialogo).toHaveTextContent("Excluir este nó?");
    expect(dialogo).toHaveTextContent("Não é possível desfazer");
    expect(onDeleteSelection).not.toHaveBeenCalled();
  });

  it("cancelar fecha a confirmação e segue sem excluir", async () => {
    const onDeleteSelection = montar("node");
    const user = usuario();

    await user.click(screen.getByTestId("delete-selection"));
    const dialogo = await screen.findByRole("alertdialog");
    await user.click(within(dialogo).getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onDeleteSelection).not.toHaveBeenCalled();
  });

  it("confirmar é o que exclui — uma vez", async () => {
    const onDeleteSelection = montar("node");
    const user = usuario();

    await user.click(screen.getByTestId("delete-selection"));
    const dialogo = await screen.findByRole("alertdialog");
    await user.click(within(dialogo).getByRole("button", { name: "Excluir" }));

    expect(onDeleteSelection).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("com aresta selecionada, a confirmação diz que é a aresta — não o nó", async () => {
    const onDeleteSelection = montar("edge");
    const user = usuario();

    await user.click(screen.getByTestId("delete-selection"));
    const dialogo = await screen.findByRole("alertdialog");

    expect(dialogo).toHaveTextContent("Excluir esta aresta?");
    expect(dialogo).not.toHaveTextContent("Excluir este nó?");

    await user.click(within(dialogo).getByRole("button", { name: "Excluir" }));
    expect(onDeleteSelection).toHaveBeenCalledTimes(1);
  });

  it("sem seleção, o irmão do fluxo ocupa o lugar — o botão da seleção não existe", () => {
    montar(null);

    expect(screen.queryByTestId("delete-selection")).toBeNull();
    expect(screen.getByTestId("delete-followup-flow")).toBeInTheDocument();
  });
});
