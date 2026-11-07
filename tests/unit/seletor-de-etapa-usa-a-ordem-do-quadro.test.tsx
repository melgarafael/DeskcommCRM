/**
 * A ORDEM DO FUNIL É UMA SÓ (#3874, fatia «renomear / reordenar / desativar»).
 *
 * A issue pede que a reestruturação das etapas feita em Configurações apareça
 * no quadro. Só que «aparecer no quadro» são DUAS leituras da mesma coluna:
 * as COLUNAS do Kanban e o seletor «Mover para…» do card. Se cada uma ordenar
 * do seu jeito, o dono reordena em Configurações, o quadro obedece e o seletor
 * continua na ordem antiga — e a conclusão dele é «não salvou».
 *
 * Este arquivo mede as duas na mesma régua (`lib/kanban/ordem-das-etapas.ts`,
 * `position` com desempate por `id`):
 *
 * 1. as colunas do quadro, com as etapas chegando EMBARALHADAS de propósito;
 * 2. os itens do seletor do card, na MESMA ordem e sem a etapa atual;
 * 3. etapa DESATIVADA (arquivada) some das duas listas — ela é histórico;
 * 4. escrever etapa em Configurações invalida o cache do QUADRO (a outra
 *    metade do «reflete no Kanban»: sem isso a tela só muda depois de F5).
 *
 * O que NÃO se mede aqui: arrastar colunas de verdade (não há drag em jsdom) e
 * a fração de `position` que o servidor grava — a prova do arrasto é de regra,
 * em `_stages.test.tsx` e nos testes da rota.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardData, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Droppable: ({ children }: { children: (p: unknown, s: unknown) => ReactNode }) =>
    children({ innerRef: () => {}, droppableProps: {}, placeholder: null }, { isDraggingOver: false }),
  Draggable: ({ children }: { children: (p: unknown, s: unknown) => ReactNode }) =>
    children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  useMoedaDaOrgAtiva: () => null,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: () => ({ data: null }) }));
vi.mock("@/hooks/leads/useReactivations", () => ({ useReactivations: () => ({ data: [] }) }));
vi.mock("@/components/kanban/LeadDossier", () => ({ LeadDossier: () => null }));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({ MoveToOtherPipelineDialog: () => null }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { KanbanCardActions } from "@/components/kanban/KanbanCardActions";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { chaveDoFunil } from "@/hooks/pipelines/useAgentMapping";
import { useArquivarEtapa, useEditarEtapa } from "@/hooks/pipelines/useStages";
import { apiClient } from "@/lib/api/client";

const PIPELINE = "p-1";
const UPDATED_AT = "2026-11-07T12:00:00.000Z";

function etapa(id: string, name: string, position: number, extra: Partial<Stage> = {}): Stage {
  return {
    id,
    organization_id: "o-1",
    pipeline_id: PIPELINE,
    name,
    slug: id,
    position,
    color: null,
    is_won: false,
    is_lost: false,
    is_archived: false,
    expected_duration_hours: null,
    ...extra,
  };
}

function lead(id: string, stageId: string, pos: number): Lead {
  return {
    id,
    organization_id: "o-1",
    pipeline_id: PIPELINE,
    stage_id: stageId,
    contact_id: null,
    title: `Negócio ${id}`,
    description: null,
    status: "open",
    lost_reason: null,
    position_in_stage: pos,
    value_cents: null,
    currency: null,
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    assigned_at: null,
    last_activity_at: null,
    stage_changed_at: UPDATED_AT,
    expected_close_date: null,
    closed_at: null,
    source: "manual",
    source_metadata: {},
    external_id: null,
    custom_fields: {},
    tags: [],
    created_at: UPDATED_AT,
    updated_at: UPDATED_AT,
    // Fixture parcial de propósito: este teste lê `stage_id` e `position_in_stage`
    // e nada mais. O duplo cast é o que o CI cobra quando o objeto não cobre
    // todos os campos que a tabela ganhou — inventar os ausentes esconderia
    // que o teste não os usa.
  } as unknown as Lead;
}

/**
 * A MESMA lista que o servidor devolve, entregue EMBARALHADA: é o que separa
 * «ordenar por `position`» de «desenhar na ordem do array». O caso real é a
 * prop vinda de um deep link/cache antigo — não uma invenção de teste.
 */
const DESORDENADAS: Stage[] = [
  etapa("s-3", "Negociação", 3000),
  etapa("s-0", "Coluna antiga", 500, { is_archived: true }),
  etapa("s-1", "Entrada", 1000),
  etapa("s-2", "Contato", 2000),
];

const ESPERADA = ["s-1", "s-2", "s-3"];

let qc: QueryClient;

function comQuery(filho: ReactNode) {
  return <QueryClientProvider client={qc}>{filho}</QueryClientProvider>;
}

function montarQuadro() {
  const funil: BoardData = {
    pipeline: { id: PIPELINE, settings: {} } as unknown as BoardData["pipeline"],
    stages: DESORDENADAS,
    leads: [lead("l-1", "s-1", 1000), lead("l-2", "s-2", 1000)],
  };
  qc.setQueryData<BoardData>(chaveDoQuadro(PIPELINE), funil);
  render(
    comQuery(
      <KanbanBoard
        pipelineId={PIPELINE}
        stages={DESORDENADAS}
        leads={funil.leads}
        pipeline={funil.pipeline}
      />,
    ),
  );
}

/** As colunas na ordem em que o DOM as desenhou. */
function colunas(): string[] {
  return Array.from(document.querySelectorAll("[data-etapa-do-quadro]")).map(
    (el) => el.getAttribute("data-etapa-do-quadro") ?? "",
  );
}

/** Os itens do bloco «Mover para…», na ordem do DOM. */
function itensDoSeletor(): string[] {
  const nomes = new Set(DESORDENADAS.map((e) => e.name));
  return Array.from(document.querySelectorAll('[role="menuitem"]'))
    .map((el) => (el.textContent ?? "").trim())
    .filter((texto) => nomes.has(texto));
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(apiClient.patch).mockResolvedValue({});
  vi.mocked(apiClient.delete).mockResolvedValue({});
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("a ordem do funil é uma só: quadro e seletor do card", () => {
  it("as COLUNAS seguem `position`, mesmo chegando embaralhadas, e a etapa desativada não vira coluna", async () => {
    montarQuadro();

    await waitFor(() => expect(colunas()).toEqual(ESPERADA));
    expect(colunas()).not.toContain("s-0");
  });

  it("o seletor «Mover para…» do card usa a MESMA ordem do quadro e esconde a etapa atual", async () => {
    const user = userEvent.setup();
    montarQuadro();
    await waitFor(() => expect(colunas()).toEqual(ESPERADA));

    const card = screen.getByRole("group", { name: "Negócio: Negócio l-1" });
    const botao = Array.from(card.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Ações do negócio",
    )!;
    await user.click(botao);
    await screen.findByRole("menuitem", { name: "Editar" });

    // A etapa do card é «Entrada» (s-1): sai da lista. «Negociação» fica por
    // último porque é a última do funil — não porque chegou primeiro.
    expect(itensDoSeletor()).toEqual(["Contato", "Negociação"]);
    expect(itensDoSeletor()).not.toContain("Coluna antiga");
  });

  it("negócio numa etapa desativada ainda tem SAÍDA: o seletor oferece todas as ativas, na ordem do quadro", async () => {
    const user = userEvent.setup();
    // Escrita fora das portas da tela (importação / banco) deixou o negócio numa
    // etapa arquivada. A coluna desativada não é destino de ninguém, mas o card
    // precisa conseguir sair dela — senão o negócio fica preso num lugar que o
    // gestor não vê.
    render(
      comQuery(
        <KanbanCardActions
          lead={lead("l-9", "s-0", 1000)}
          pipelineId={PIPELINE}
          etapas={DESORDENADAS}
          onMoverPara={() => {}}
        />,
      ),
    );

    // Aqui só o menu é montado (sem o card em volta): o alvo é o seletor.
    await user.click(screen.getByRole("button", { name: "Ações do negócio" }));
    await screen.findByRole("menuitem", { name: "Editar" });

    expect(itensDoSeletor()).toEqual(["Entrada", "Contato", "Negociação"]);
  });
});

describe("escrever etapa em Configurações chega ao quadro", () => {
  it("reordenar e desativar invalidam o cache do QUADRO, não só o da tela de etapas", async () => {
    qc.setQueryData(chaveDoQuadro(PIPELINE), { pipeline: {}, stages: [], leads: [] });
    qc.setQueryData(chaveDoFunil(PIPELINE), { etapas: [] });

    const editar = renderHook(() => useEditarEtapa(PIPELINE), { wrapper: ({ children }) => comQuery(children) });
    await act(async () => {
      await editar.result.current.mutateAsync({ stageId: "s-3", patch: { depois_de: "s-1" } });
    });

    expect(apiClient.patch).toHaveBeenCalledWith(
      `/api/v1/pipelines/${PIPELINE}/stages/s-3`,
      { depois_de: "s-1" },
    );
    expect(qc.getQueryState(chaveDoQuadro(PIPELINE))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(chaveDoFunil(PIPELINE))?.isInvalidated).toBe(true);

    const arquivar = renderHook(() => useArquivarEtapa(PIPELINE), {
      wrapper: ({ children }) => comQuery(children),
    });
    qc.setQueryData(chaveDoQuadro(PIPELINE), { pipeline: {}, stages: [], leads: [] });
    await act(async () => {
      await arquivar.result.current.mutateAsync({ stageId: "s-2", destinoId: "s-1" });
    });

    expect(apiClient.delete).toHaveBeenCalledWith(
      `/api/v1/pipelines/${PIPELINE}/stages/s-2?destino=s-1`,
    );
    expect(qc.getQueryState(chaveDoQuadro(PIPELINE))?.isInvalidated).toBe(true);
  });
});
