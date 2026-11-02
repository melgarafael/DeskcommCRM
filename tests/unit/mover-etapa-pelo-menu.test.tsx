/**
 * "Mover para…" no menu do card — o jeito de trocar de etapa no celular, onde
 * arrastar é um toque longo que disputa com a rolagem.
 *
 * A árvore é a de verdade (quadro → coluna → card → menu); só o dnd vira
 * dublê, para o arrasto entrar pelo `onDragEnd` como nos irmãos de
 * `arrastar-le-o-updated-at-do-cache.test.tsx`. O `apiClient` também é o real:
 * o que se mede é o corpo que sai no fio e o que a tela faz com a recusa que
 * volta dele (o 422 com `details.faltando` vira `ApiError` lá dentro).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardData, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

const capturado = vi.hoisted(() => ({
  onDragEnd: null as ((r: unknown) => void) | null,
}));
const papel = vi.hoisted(() => ({ podeMover: true }));

vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ onDragEnd, children }: { onDragEnd: (r: unknown) => void; children: ReactNode }) => {
    capturado.onDragEnd = onDragEnd;
    return <div>{children}</div>;
  },
  Droppable: ({ children }: { children: (p: unknown, s: unknown) => ReactNode }) =>
    children({ innerRef: () => {}, droppableProps: {}, placeholder: null }, { isDraggingOver: false }),
  Draggable: ({ children }: { children: (p: unknown, s: unknown) => ReactNode }) =>
    children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (chave: string) => chave === "pipeline.move_card" && papel.podeMover,
  // A janela de campos obrigatórios lê a moeda da organização (sem org: a moeda padrão).
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

import { KanbanBoard } from "@/components/kanban/KanbanBoard";

const PIPELINE = "p-1";
const UPDATED_AT = "2026-10-20T12:00:00.000Z";

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

function lead(id: string, stageId: string, pos: number, extra: Partial<Lead> = {}): Lead {
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
    ...extra,
  } as Lead;
}

const ETAPAS = [
  etapa("s-1", "Entrada", 0),
  etapa("s-2", "Contato", 1),
  etapa("s-3", "Perdido", 2, { is_lost: true }),
];
const MOVIDO = lead("l-1", "s-1", 1000);
const VISIVEL_NO_CONTATO = lead("l-2", "s-2", 1000);
// O filtro da página esconde este card: ele está no cache do quadro e fora das
// props. É ele quem define o topo da etapa (#2545, #3461).
const ESCONDIDO_NO_CONTATO = lead("l-3", "s-2", -5000);

let qc: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;

function respostaJson(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
}

/** Os POSTs de move que saíram, com o corpo já decodificado. */
function movesEnviados(): Array<{ url: string; corpo: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith("/move") && (init as RequestInit)?.method === "POST")
    .map(([url, init]) => ({ url: String(url), corpo: JSON.parse(String((init as RequestInit).body)) }));
}

function montar(visiveis: Lead[] = [MOVIDO, VISIVEL_NO_CONTATO]) {
  const funil: BoardData = {
    pipeline: { id: PIPELINE, settings: {} } as unknown as BoardData["pipeline"],
    stages: ETAPAS,
    leads: [...visiveis, ESCONDIDO_NO_CONTATO],
  };
  qc.setQueryData<BoardData>(["board", PIPELINE], funil);
  render(
    <QueryClientProvider client={qc}>
      <KanbanBoard
        pipelineId={PIPELINE}
        stages={ETAPAS}
        leads={visiveis}
        pipeline={funil.pipeline}
      />
    </QueryClientProvider>,
  );
}

async function abrirMenuDoMovido(user: ReturnType<typeof userEvent.setup>, alvo: Lead = MOVIDO) {
  const card = screen.getByRole("group", { name: `Lead: ${alvo.title}` });
  const botao = Array.from(card.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "Ações do lead",
  )!;
  await user.click(botao);
  await screen.findByRole("menuitem", { name: "Editar" });
}

beforeEach(() => {
  papel.podeMover = true;
  capturado.onDragEnd = null;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? respostaJson(200, { data: { ...MOVIDO, stage_id: "s-2", updated_at: "2026-10-20T12:00:01.000Z" } })
      : new Promise<Response>(() => {}),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Mover para… no menu do card", () => {
  it("lista as outras etapas e manda o move para o TOPO da etapa INTEIRA (#3461), com o updated_at do card", async () => {
    const user = userEvent.setup();
    montar();
    await abrirMenuDoMovido(user);

    expect(screen.getByText("Mover para…")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Entrada" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Contato" }));

    await waitFor(() => expect(movesEnviados()).toHaveLength(1));
    const [move] = movesEnviados();
    expect(move?.url).toBe(`/api/v1/leads/${MOVIDO.id}/move`);
    expect(move?.corpo).toEqual({
      stage_id: "s-2",
      position_in_stage: -6000,
      expected_updated_at: UPDATED_AT,
    });
  });

  it("etapa de perda sem motivo abre a janela do motivo, e o move só sai com ele", async () => {
    const user = userEvent.setup();
    montar();
    await abrirMenuDoMovido(user);
    await user.click(screen.getByRole("menuitem", { name: "Perdido" }));

    const janela = await screen.findByRole("dialog", { name: "Marcar como perdido" });
    expect(movesEnviados()).toHaveLength(0);

    const motivo = janela.querySelector<HTMLInputElement>('input[type="radio"]')!;
    await user.click(motivo);
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(movesEnviados()).toHaveLength(1));
    expect(movesEnviados()[0]?.corpo).toMatchObject({ stage_id: "s-3", lost_reason: motivo.value });
  });

  it("a recusa de campos obrigatórios que volta do menu abre a janela de campos", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? respostaJson(422, {
            error: {
              code: "required_fields_missing",
              message: "Faltam campos",
              details: { faltando: [{ chave: "cpf", rotulo: "CPF" }] },
            },
          })
        : new Promise<Response>(() => {}),
    );
    const user = userEvent.setup();
    montar();
    await abrirMenuDoMovido(user);
    await user.click(screen.getByRole("menuitem", { name: "Contato" }));

    expect(await screen.findByRole("dialog", { name: "Campos obrigatórios" })).toBeTruthy();
  });

  it("quem não pode mover o card não vê a lista de etapas", async () => {
    papel.podeMover = false;
    const user = userEvent.setup();
    montar();
    await abrirMenuDoMovido(user);

    expect(screen.queryByText("Mover para…")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Contato" })).toBeNull();
  });

  it("arrastar para a etapa de perda também pede o motivo, em vez de mandar o move sem ele", async () => {
    montar();
    await waitFor(() => expect(capturado.onDragEnd).not.toBeNull());

    await act(async () => {
      capturado.onDragEnd?.({
        draggableId: MOVIDO.id,
        source: { droppableId: "s-1", index: 0 },
        destination: { droppableId: "s-3", index: 0 },
        reason: "DROP",
        type: "DEFAULT",
        mode: "FLUID",
      });
    });

    expect(await screen.findByRole("dialog", { name: "Marcar como perdido" })).toBeTruthy();
    expect(movesEnviados()).toHaveLength(0);
  });

  // O negócio REABERTO volta a `open` com o `lost_reason` da perda anterior na
  // linha (`fn_crm_lead_close_on_stage` não o limpa). Esse motivo é de outra
  // perda: levá-lo de novo à etapa de perda tem de pedir o motivo desta.
  it("negócio reaberto com motivo da perda anterior: Perdido abre a janela em vez de reaproveitar o motivo velho", async () => {
    const reaberto = lead("l-9", "s-1", 2000, { status: "open", lost_reason: "price" });
    const user = userEvent.setup();
    montar([MOVIDO, VISIVEL_NO_CONTATO, reaberto]);
    await abrirMenuDoMovido(user, reaberto);
    await user.click(screen.getByRole("menuitem", { name: "Perdido" }));

    expect(await screen.findByRole("dialog", { name: "Marcar como perdido" })).toBeTruthy();
    expect(movesEnviados()).toHaveLength(0);
  });

  it("controle: reordenar dentro da coluna de perda usa o motivo que o card já tem, sem janela", async () => {
    const perdidoA = lead("l-7", "s-3", 1000, { status: "lost", lost_reason: "price" });
    const perdidoB = lead("l-8", "s-3", 2000, { status: "lost", lost_reason: "no_response" });
    montar([MOVIDO, perdidoA, perdidoB]);
    await waitFor(() => expect(capturado.onDragEnd).not.toBeNull());

    await act(async () => {
      capturado.onDragEnd?.({
        draggableId: perdidoA.id,
        source: { droppableId: "s-3", index: 0 },
        destination: { droppableId: "s-3", index: 1 },
        reason: "DROP",
        type: "DEFAULT",
        mode: "FLUID",
      });
    });

    await waitFor(() => expect(movesEnviados()).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Marcar como perdido" })).toBeNull();
    expect(movesEnviados()[0]?.corpo).not.toHaveProperty("lost_reason");
  });

  it("Cancelar a janela do motivo não move nada, e o motivo escolhido não vaza para o próximo negócio", async () => {
    const user = userEvent.setup();
    montar();
    await abrirMenuDoMovido(user);
    await user.click(screen.getByRole("menuitem", { name: "Perdido" }));
    const janela = await screen.findByRole("dialog", { name: "Marcar como perdido" });
    await user.click(janela.querySelector<HTMLInputElement>('input[type="radio"]')!);
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Marcar como perdido" })).toBeNull());
    expect(movesEnviados()).toHaveLength(0);

    await abrirMenuDoMovido(user, VISIVEL_NO_CONTATO);
    await user.click(screen.getByRole("menuitem", { name: "Perdido" }));
    const outra = await screen.findByRole("dialog", { name: "Marcar como perdido" });
    expect(Array.from(outra.querySelectorAll<HTMLInputElement>('input[type="radio"]')).some((r) => r.checked)).toBe(false);
    expect((screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(movesEnviados()).toHaveLength(0);
  });

  it("perda com motivo que volta com campos faltando: o reenvio da janela de campos ainda leva o motivo", async () => {
    let posts = 0;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return new Promise<Response>(() => {});
      posts += 1;
      return posts === 1
        ? respostaJson(422, {
            error: {
              code: "required_fields_missing",
              message: "Faltam campos",
              details: { faltando: [{ chave: "cpf", rotulo: "CPF" }] },
            },
          })
        : respostaJson(200, { data: { ...MOVIDO, stage_id: "s-3", status: "lost" } });
    });
    const user = userEvent.setup();
    montar();
    await abrirMenuDoMovido(user);
    await user.click(screen.getByRole("menuitem", { name: "Perdido" }));
    const janela = await screen.findByRole("dialog", { name: "Marcar como perdido" });
    const motivo = janela.querySelector<HTMLInputElement>('input[type="radio"]')!;
    await user.click(motivo);
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await screen.findByRole("dialog", { name: "Campos obrigatórios" });
    await user.type(screen.getByRole("textbox", { name: "CPF" }), "123");
    await user.click(screen.getByRole("button", { name: "Mover agora" }));

    await waitFor(() => expect(movesEnviados()).toHaveLength(2));
    expect(movesEnviados()[0]?.corpo).toMatchObject({ lost_reason: motivo.value });
    expect(movesEnviados()[1]?.corpo).toMatchObject({
      stage_id: "s-3",
      lost_reason: motivo.value,
      custom_fields: { cpf: "123" },
    });
  });
});
