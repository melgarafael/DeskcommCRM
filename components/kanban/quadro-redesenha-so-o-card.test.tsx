/**
 * Funil rápido (#4788), o QUADRO inteiro. Mede:
 *
 * 1. Um card solto no fim da parte mostrada de uma coluna de ganho com mais de
 *    50 negócios vira o 51º da etapa e não some da tela.
 * 2. O negócio do deep link (`leadInicial`, `?lead=`) aparece mesmo além do corte.
 * 3. Marcar um card (com outro já marcado) redesenha só ele.
 * 4. Soltar um card redesenha só ele: os callbacks que atravessam até os cards
 *    não mudam a cada `data`.
 *
 * Board, coluna e lista de cards de verdade; o card é dublê que conta renders e
 * guarda as props.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MoveArgs } from "@/hooks/kanban/useMoveCard";
import type { Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

const h = vi.hoisted(() => ({
  renders: new Map<string, number>(),
  props: new Map<string, { onSelect?: (id: string, g: "alterna" | "intervalo") => void }>(),
  onDragEnd: null as ((r: unknown) => void) | null,
  mutate: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ onDragEnd, children }: { onDragEnd: (r: unknown) => void; children: ReactNode }) => {
    h.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
  Droppable: ({ children }: { children: (p: object, s: object) => ReactNode }) => (
    <>{children({ innerRef: () => {}, droppableProps: {}, placeholder: null }, { isDraggingOver: false })}</>
  ),
}));
vi.mock("@/components/kanban/KanbanCard", () => ({
  KanbanCard: (p: { lead: { id: string }; onSelect?: (id: string, g: "alterna" | "intervalo") => void }) => {
    h.renders.set(p.lead.id, (h.renders.get(p.lead.id) ?? 0) + 1);
    h.props.set(p.lead.id, p);
    return <div data-testid="card" data-id={p.lead.id} />;
  },
}));
vi.mock("@/hooks/kanban/useBoard", () => ({
  useBoard: () => ({ data: undefined, isLoading: false, isError: false, error: null, pulses: undefined }),
  chaveDoQuadro: (id: string | null) => ["board", id],
}));
vi.mock("@/hooks/kanban/useMoveCard", () => ({
  useMoveCard: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock("@/hooks/kanban/useRenameStage", () => ({ useRenameStage: () => ({ mutate: vi.fn() }) }));
// Dado ESTÁVEL entre renders, como o do react-query de verdade (um `[]` novo
// por chamada invalidaria o memo).
const VAZIO = vi.hoisted(() => ({ data: [] as never[] }));
const SEM_RISCO = vi.hoisted(() => ({ data: null }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => VAZIO }));
vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: () => SEM_RISCO }));
vi.mock("@/hooks/leads/useReactivations", () => ({ useReactivations: () => VAZIO }));
vi.mock("@/components/kanban/LeadDossier", () => ({ LeadDossier: () => null }));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("@/components/kanban/CamposObrigatoriosDialog", () => ({ CamposObrigatoriosDialog: () => null }));
vi.mock("@/components/kanban/RetomarComoNovoNegocioDialog", () => ({ RetomarComoNovoNegocioDialog: () => null }));

import { KanbanBoard } from "@/components/kanban/KanbanBoard";

const ETAPAS = [
  { id: "s-aberta", pipeline_id: "p-1", name: "Negociação", position: 0, color: null, is_won: false, is_lost: false },
  { id: "s-ganho", pipeline_id: "p-1", name: "Ganho", position: 1, color: null, is_won: true, is_lost: false },
] as unknown as Stage[];

function negocio(id: string, stageId: string, pos: number): Lead {
  return {
    id,
    title: id,
    stage_id: stageId,
    position_in_stage: pos,
    status: stageId === "s-ganho" ? "won" : "open",
    value_cents: null,
    currency: null,
    tags: [],
    updated_at: "2026-11-16T00:00:00Z",
  } as unknown as Lead;
}

const GANHOS = Array.from({ length: 60 }, (_, i) => negocio(`g-${String(i).padStart(3, "0")}`, "s-ganho", (i + 1) * 1000));
const ABERTOS = Array.from({ length: 5 }, (_, i) => negocio(`a-${i}`, "s-aberta", (i + 1) * 1000));

let mover: (args: MoveArgs) => void = () => {};

/** A página: dona dos negócios e da seleção, como o `_client` (seleção em array). */
function Pagina({ inicial, leadInicial }: { inicial: Lead[]; leadInicial?: string }) {
  const [leads, setLeads] = useState(inicial);
  const [sel, setSel] = useState<string[]>([]);
  useEffect(() => {
    mover = (args) =>
      setLeads((ls) =>
        ls.map((l) =>
          l.id === args.leadId
            ? { ...l, stage_id: args.stageId, position_in_stage: args.positionInStage ?? l.position_in_stage }
            : l,
        ),
      );
  }, []);
  return (
    <KanbanBoard
      pipelineId="p-1"
      stages={ETAPAS}
      leads={leads}
      selectedIds={sel}
      onSelectionChange={setSel}
      leadInicial={leadInicial}
    />
  );
}

function montar(inicial: Lead[], leadInicial?: string) {
  const qc = new QueryClient();
  qc.setQueryData(["board", "p-1"], { pipeline: {}, stages: ETAPAS, leads: inicial });
  return render(
    <QueryClientProvider client={qc}>
      <Pagina inicial={inicial} leadInicial={leadInicial} />
    </QueryClientProvider>,
  );
}

/** Solta o card e aplica o move como o otimista do `useMoveCard` faria. */
function soltar(draggableId: string, de: string, indiceDe: number, para: string, indicePara: number) {
  act(() => {
    h.onDragEnd?.({
      draggableId,
      source: { droppableId: de, index: indiceDe },
      destination: { droppableId: para, index: indicePara },
      reason: "DROP",
      type: "LEAD",
      mode: "FLUID",
    });
  });
  expect(h.mutate).toHaveBeenCalledTimes(1);
  act(() => mover(h.mutate.mock.calls[0]![0] as MoveArgs));
}

const total = () => [...h.renders.values()].reduce((a, b) => a + b, 0);

beforeEach(() => {
  h.renders.clear();
  h.props.clear();
  h.onDragEnd = null;
  h.mutate.mockReset();
});
afterEach(cleanup);

describe("cards além do corte de ganho/perda", () => {
  it("soltar no fim da parte mostrada de um Ganho com 60 negócios: o card continua na tela", () => {
    montar([...ABERTOS, ...GANHOS]);
    expect(screen.getAllByTestId("card")).toHaveLength(5 + 50);

    soltar("a-4", "s-aberta", 4, "s-ganho", 50); // logo abaixo do 50º mostrado

    const posicao = (h.mutate.mock.calls[0]![0] as MoveArgs).positionInStage;
    expect(posicao).toBeGreaterThan(50_000); // entre o 50º…
    expect(posicao).toBeLessThan(51_000); // …e o 51º, escondido: vira o 51º da etapa
    const ids = screen.getAllByTestId("card").map((c) => c.getAttribute("data-id"));
    expect(ids).toContain("a-4");
  });

  it("o negócio do deep link `?lead=` aparece mesmo além do corte", () => {
    montar([...ABERTOS, ...GANHOS], "g-055");
    const ids = screen.getAllByTestId("card").map((c) => c.getAttribute("data-id"));
    expect(ids).toContain("g-055");
    expect(ids).toHaveLength(5 + 56);
  });
});

describe("o quadro não redesenha todos os cards", () => {
  it("marcar um card (com outro já marcado) redesenha só ele", () => {
    montar([...ABERTOS, ...GANHOS]);
    act(() => h.props.get("a-0")!.onSelect!("a-0", "alterna"));
    // O primeiro marcado liga o modo de seleção em todos (`isSelecting`): esperado.
    h.renders.clear();
    act(() => h.props.get("a-1")!.onSelect!("a-1", "alterna"));
    expect([...h.renders.entries()]).toEqual([["a-1", 1]]);
  });

  it("soltar um card no fim de outra coluna redesenha só ele", () => {
    montar([...ABERTOS, ...GANHOS.slice(0, 10)]);
    h.renders.clear();
    soltar("a-4", "s-aberta", 4, "s-ganho", 10); // o último de uma coluna para o fim da outra
    expect([...h.renders.keys()]).toEqual(["a-4"]);
    expect(total()).toBeLessThanOrEqual(2);
  });
});
