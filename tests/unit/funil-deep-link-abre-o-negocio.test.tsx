import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BoardData } from "@/lib/kanban/types";

/**
 * O DEEP LINK DO QUADRO: `?lead=` LEVA O CARD CERTO (issue #3004).
 *
 * O painel do Inbox ganhou o atalho "Abrir no funil" (#3004) que aponta para
 * `/app/pipelines/<id>?lead=<id>`. Este caso prende o outro lado do contrato: o
 * quadro resolve esse parâmetro para o negócio certo e o abre no ESTADO em que
 * ele está (a etapa), em vez de deixar a pessoa num quadro genérico procurando
 * o card — que era exatamente o trabalho que a issue pediu para eliminar.
 *
 * Dois negócios no quadro de propósito: com um só, "abriu algum dossiê" passaria
 * mesmo se o parâmetro fosse ignorado e o primeiro card abrisse por acaso.
 */
const capturado = vi.hoisted(() => ({
  dossies: [] as Array<{ leadId: string; stageName: string; pipelineId: string }>,
}));

vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/kanban/StageColumn", () => ({ StageColumn: () => null }));
vi.mock("@/components/kanban/LeadDossier", () => ({
  LeadDossier: (p: { lead: { id: string }; stageName: string; pipelineId: string }) => {
    capturado.dossies.push({ leadId: p.lead.id, stageName: p.stageName, pipelineId: p.pipelineId });
    return <div data-testid="dossie-aberto">{`${p.lead.id}@${p.stageName}`}</div>;
  },
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: () => ({ data: null }) }));
vi.mock("@/hooks/leads/useReactivations", () => ({ useReactivations: () => ({ data: [] }) }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "SUBSCRIBED", ultimaEntrega: null }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({ useRefetchDeSeguranca: () => undefined }));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(() => new Promise<never>(() => {})), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { KanbanBoard } from "@/components/kanban/KanbanBoard";

const PIPELINE = "p-1";

/** Dois negócios, em etapas diferentes — o `leadInicial` tem de escolher UM. */
const quadro = {
  pipeline: { id: PIPELINE, name: "Origem", settings: null },
  stages: [
    { id: "s-1", name: "Novo", position: 0, is_won: false, is_lost: false, is_archived: false },
    { id: "s-2", name: "Contato", position: 1, is_won: false, is_lost: false, is_archived: false },
  ],
  leads: [
    { id: "l-0", title: "Primeiro", stage_id: "s-1", position_in_stage: 1000 },
    { id: "l-1", title: "Segundo", stage_id: "s-2", position_in_stage: 1000 },
  ],
} as unknown as BoardData;

function montar(leadInicial: string | null) {
  capturado.dossies = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KanbanBoard
        pipelineId={PIPELINE}
        pipeline={quadro.pipeline}
        stages={quadro.stages}
        leads={quadro.leads}
        leadInicial={leadInicial}
      />
    </QueryClientProvider>,
  );
}

describe("quadro do funil — `?lead=` abre o negócio certo (#3004)", () => {
  it("abre o dossiê do negócio apontado, na etapa em que ele está", () => {
    montar("l-1");
    // O SEGUNDO negócio (não o primeiro da lista) e a etapa dele.
    expect(screen.getByTestId("dossie-aberto")).toHaveTextContent("l-1@Contato");
    expect(capturado.dossies).toEqual([
      { leadId: "l-1", stageName: "Contato", pipelineId: PIPELINE },
    ]);
  });

  it("sem `?lead=` o quadro abre sem dossiê nenhum", () => {
    montar(null);
    expect(screen.queryByTestId("dossie-aberto")).toBeNull();
    expect(capturado.dossies).toEqual([]);
  });

  it("um `?lead=` de outro funil não abre dossiê errado nem inventa card", () => {
    // Card que não está na lista: nada abre — nunca "o primeiro da fila", que
    // seria abrir o negócio de outra pessoa por causa de um id desconhecido.
    montar("l-de-outro-funil");
    expect(screen.queryByTestId("dossie-aberto")).toBeNull();
  });
});
