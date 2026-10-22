/**
 * O botão de excluir mora na casca do painel, não em cada formulário — um
 * único lugar cobre os 8 tipos. O loop abaixo é a prova de que nenhum tipo
 * troca o painel por outra casca e perde o botão.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NODE_TYPES, type FlowGraph } from "@/lib/followup/graph-schema";
import type { RFNode } from "@/lib/followup/graph-mappers";

import { NodeConfigPanel } from "./NodeConfigPanel";
import { NODE_VISUALS } from "./nodes/nodeVisuals";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => false,
}));
// A lista de atribuição vem de uma rota; aqui o formulário só precisa de um
// nome para mostrar — e jsdom não tem servidor.
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({
    data: [{ user_id: "99999999-0000-4000-8000-000000000009", role: "agent", full_name: "Ana Souza" }],
  }),
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

/** Painel com as pontas que o canvas liga: mudança do nó, mudança do grafo. */
function montarCom(
  tipo: (typeof NODE_TYPES)[number],
  extras: {
    onChange?: (patch: unknown) => void;
    settings?: FlowGraph["settings"];
    onSettingsChange?: (s: FlowGraph["settings"]) => void;
    surface?: "followup" | "crm_automation" | "atendimento";
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChange = extras.onChange ?? vi.fn();
  render(
    <QueryClientProvider client={client}>
      <NodeConfigPanel
        node={noDe(tipo)}
        onChange={onChange}
        onDelete={vi.fn()}
        {...(extras.surface ? { surface: extras.surface } : {})}
        {...(extras.settings ? { settings: extras.settings } : {})}
        {...(extras.onSettingsChange ? { onSettingsChange: extras.onSettingsChange } : {})}
      />
    </QueryClientProvider>,
  );
  return onChange;
}

/**
 * O nó `internal_task` no construtor (#1540, item 2).
 *
 * A caixa estava na paleta, no schema, no publish e no motor — e o formulário
 * não: quem arrastava ficava com o `defaultConfig` para sempre, sem poder
 * mudar título, prazo, atribuição nem prioridade. Medir aqui é medir a tela,
 * não o schema (o schema já tem teste próprio em `graph-schema.test.ts`).
 */
describe("NodeConfigPanel — o formulário do lembrete interno", () => {
  it("⭐ oferece título, prazo, atribuição e prioridade para o tipo internal_task", () => {
    const onChange = montarCom("internal_task");

    const titulo = screen.getByLabelText("Título da tarefa");
    expect(titulo, "o campo que quem arrasta a caixa não conseguia alcançar").toHaveValue(
      "Ligar para {{contact.name}}",
    );
    expect(screen.getByLabelText("Vence em (dias)")).toBeInTheDocument();
    expect(screen.getByLabelText("Prioridade")).toBeInTheDocument();
    expect(screen.getByLabelText("Atribuir a")).toBeInTheDocument();

    fireEvent.change(titulo, { target: { value: "Ligar antes do fim do dia" } });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ titulo: "Ligar antes do fim do dia" }),
      }),
    );
  });

  it("recusa título vazio e mantém a última configuração válida", () => {
    const onChange = montarCom("internal_task");

    fireEvent.change(screen.getByLabelText("Título da tarefa"), { target: { value: "" } });

    expect(screen.getByRole("alert"), "a recusa fica visível em vez de calada").toBeInTheDocument();
    expect(
      onChange,
      "um nó gravado pela metade vira tarefa sem título, que o CHECK do banco recusa sem dizer por quê",
    ).not.toHaveBeenCalled();
  });

  it('⭐ a marca "somente interno" existe na tela e grava nas configurações do fluxo', async () => {
    const onSettingsChange = vi.fn();
    montarCom("trigger", { onSettingsChange });

    const marca = screen.getByTestId("somente-interno").querySelector('[role="switch"]');
    expect(
      marca,
      'a guarda de publicação manda o operador "tirar a marca" e não havia lugar na tela para pô-la',
    ).not.toBeNull();

    await userEvent.setup({ delay: null }).click(marca!);

    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ somente_interno: true }),
    );
  });
});

// #1130 (@vgamkt), decisão do doc 69 (b): cada roteiro escolhe se recomeça para
// quem já o concluiu, e o padrão é NÃO.
describe("NodeConfigPanel — o roteiro que recomeça", () => {
  it("nasce desligado e, ligado, grava `pode_recomecar` nas configurações do roteiro", async () => {
    const onSettingsChange = vi.fn();
    montarCom("trigger", { surface: "atendimento", onSettingsChange });

    const chave = screen.getByTestId("roteiro-pode-recomecar").querySelector('[role="switch"]');
    expect(chave).not.toBeNull();
    expect(chave).toHaveAttribute("aria-checked", "false");

    await userEvent.setup({ delay: null }).click(chave!);
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ pode_recomecar: true }));
  });

  it("desligar tira a chave do grafo (volta ao padrão) sem perder as outras configurações", async () => {
    const onSettingsChange = vi.fn();
    montarCom("trigger", {
      surface: "atendimento",
      settings: { max_tentativas_pergunta: 4, gatilhos: ["agendar"], pode_recomecar: true },
      onSettingsChange,
    });

    const chave = screen.getByTestId("roteiro-pode-recomecar").querySelector('[role="switch"]');
    expect(chave).toHaveAttribute("aria-checked", "true");
    await userEvent.setup({ delay: null }).click(chave!);

    const gravado = onSettingsChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(gravado).toEqual({ max_tentativas_pergunta: 4, gatilhos: ["agendar"] });
  });
});
