import { readFileSync } from "node:fs";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardData, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";

/**
 * MUDAR A ETAPA PELO DOSSIÊ.
 *
 * ─── O pedido, de quem usa ──────────────────────────────────────────────────
 *
 * "Quando estou no card de um lead e quero mover de etapa, só dá para arrastar
 * no quadro ou ir na conversa. No card não dá." O dossiê mostrava a etapa como
 * TEXTO no cabeçalho: era a única superfície do negócio sem como mudá-la, e é
 * justamente onde se decide o próximo passo.
 *
 * O seletor não move nada sozinho: ele chama `onMudar`, e o quadro liga esse fio
 * ao MESMO caminho do "Mover para…" do card (`aoMoverPelaLista` → `moverPara`).
 * Por isso a segunda metade deste arquivo renderiza o QUADRO de verdade e mede o
 * move que sai no fio: fim da etapa inteira, `updated_at` do card, a janela do
 * motivo antes da perda e a janela de campos na recusa — as mesmas regras de
 * `mover-etapa-pelo-menu.test.tsx`.
 */

// ─── Dublês do quadro (os mesmos de mover-etapa-pelo-menu.test.tsx) ─────────
const papel = vi.hoisted(() => ({ podeMover: true }));

vi.mock("@hello-pangea/dnd", () => ({
  DragDropContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Droppable: ({ children }: { children: (p: unknown, s: unknown) => ReactNode }) =>
    children({ innerRef: () => {}, droppableProps: {}, placeholder: null }, { isDraggingOver: false }),
  Draggable: ({ children }: { children: (p: unknown, s: unknown) => ReactNode }) =>
    children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: (chave: string) => chave === "pipeline.move_card" && papel.podeMover,
  useMoedaDaOrgAtiva: () => null,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: () => ({ data: null }) }));
vi.mock("@/hooks/leads/useReactivations", () => ({ useReactivations: () => ({ data: [] }) }));
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({ MoveToOtherPipelineDialog: () => null }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
// O dossiê inteiro puxa linha do tempo, tarefas e propostas. O que se mede aqui
// é o fio que o QUADRO entrega a ele: o dublê só expõe `etapas`/`onMudarEtapa`
// como botões. Que o dossiê real monta o seletor com esse fio é o último bloco.
vi.mock("@/components/kanban/LeadDossier", () => ({
  LeadDossier: (p: { etapas?: Pick<Stage, "id" | "name">[]; onMudarEtapa?: (stageId: string) => void }) => (
    <div data-testid="dossie">
      {p.etapas?.map((e) => (
        <button key={e.id} type="button" onClick={() => p.onMudarEtapa?.(e.id)}>
          {`dossiê → ${e.name}`}
        </button>
      ))}
    </div>
  ),
}));

import { EtapaNoDossie } from "@/components/kanban/EtapaNoDossie";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";

// O Select do Radix usa APIs de ponteiro/rolagem que o jsdom não tem (mesmo apoio de etapa-pela-conversa.test.tsx).
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();

const etapasDoSeletor = [
  { id: "s-novo", name: "Novo Lead" },
  { id: "s-neg", name: "Negociando" },
  { id: "s-perdeu", name: "Perdemos" },
];

function montarSeletor(extra: Partial<Parameters<typeof EtapaNoDossie>[0]> = {}) {
  const onMudar = vi.fn();
  render(<EtapaNoDossie etapaAtual="s-novo" etapas={etapasDoSeletor} podeMover onMudar={onMudar} {...extra} />);
  return onMudar;
}

describe("dossiê — o seletor Etapa do funil", () => {
  it("mostra a etapa atual num seletor com as etapas do funil, na ordem", async () => {
    montarSeletor();
    const user = userEvent.setup();
    const seletor = screen.getByRole("combobox", { name: "Etapa do funil" });
    expect(seletor.textContent).toContain("Novo Lead");
    await user.click(seletor);
    const opcoes = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(opcoes).toEqual(["Novo Lead", "Negociando", "Perdemos"]);
  });

  it("escolher outra etapa — inclusive a de perda — pede o movimento a quem chama, com o id da etapa", async () => {
    // A perda NÃO é decidida aqui: quem chama (o quadro) pede o motivo antes do move.
    const onMudar = montarSeletor();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Etapa do funil" }));
    await user.click(await screen.findByRole("option", { name: "Perdemos" }));
    expect(onMudar).toHaveBeenCalledTimes(1);
    expect(onMudar).toHaveBeenCalledWith("s-perdeu");
  });

  it("escolher a etapa em que já está não move", async () => {
    const onMudar = montarSeletor();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Etapa do funil" }));
    await user.click(await screen.findByRole("option", { name: "Novo Lead" }));
    expect(onMudar).not.toHaveBeenCalled();
  });

  it("sem permissão de mover, fica o texto da etapa — sem seletor que recusaria no clique", () => {
    montarSeletor({ podeMover: false });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Novo Lead")).toBeInTheDocument();
  });

  it("sem a lista de etapas, também fica o texto", () => {
    montarSeletor({ etapas: [] });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

// ─── O quadro: o dossiê move pela MESMA regra do "Mover para…" ──────────────
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
    created_by_user_id: null,
    external_id: null,
    custom_fields: {},
    tags: [],
    created_at: UPDATED_AT,
    updated_at: UPDATED_AT,
  } as Lead;
}

const ETAPAS = [etapa("s-1", "Entrada", 0), etapa("s-2", "Contato", 1), etapa("s-3", "Perdido", 2, { is_lost: true })];
const MOVIDO = lead("l-1", "s-1", 1000);
const VISIVEL_NO_CONTATO = lead("l-2", "s-2", 1000);
// Escondido pelo filtro da página: está só no cache do quadro e define o fim da etapa (#2545).
const ESCONDIDO_NO_CONTATO = lead("l-3", "s-2", 5000);

let qc: QueryClient;
let fetchMock: ReturnType<typeof vi.fn>;

function respostaJson(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
}

function movesEnviados(): Array<{ url: string; corpo: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith("/move") && (init as RequestInit)?.method === "POST")
    .map(([url, init]) => ({ url: String(url), corpo: JSON.parse(String((init as RequestInit).body)) }));
}

async function abrirDossieDoMovido(user: ReturnType<typeof userEvent.setup>) {
  const visiveis = [MOVIDO, VISIVEL_NO_CONTATO];
  const funil: BoardData = {
    pipeline: { id: PIPELINE, settings: {} } as unknown as BoardData["pipeline"],
    stages: ETAPAS,
    leads: [...visiveis, ESCONDIDO_NO_CONTATO],
  };
  qc.setQueryData<BoardData>(["board", PIPELINE], funil);
  render(
    <QueryClientProvider client={qc}>
      <KanbanBoard pipelineId={PIPELINE} stages={ETAPAS} leads={visiveis} pipeline={funil.pipeline} />
    </QueryClientProvider>,
  );
  await user.click(screen.getByText(MOVIDO.title));
  await screen.findByTestId("dossie");
}

describe("o quadro move pelo dossiê com a regra do Mover para…", () => {
  beforeEach(() => {
    papel.podeMover = true;
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

  it("vai para o FIM da etapa inteira (cache do quadro), com o updated_at do card", async () => {
    const user = userEvent.setup();
    await abrirDossieDoMovido(user);
    await user.click(screen.getByRole("button", { name: "dossiê → Contato" }));

    await waitFor(() => expect(movesEnviados()).toHaveLength(1));
    expect(movesEnviados()[0]).toEqual({
      url: `/api/v1/leads/${MOVIDO.id}/move`,
      corpo: { stage_id: "s-2", position_in_stage: 6000, expected_updated_at: UPDATED_AT },
    });
  });

  it("a etapa de perda abre a janela do motivo do quadro, e o move só sai com o motivo", async () => {
    const user = userEvent.setup();
    await abrirDossieDoMovido(user);
    await user.click(screen.getByRole("button", { name: "dossiê → Perdido" }));

    const janela = await screen.findByRole("dialog", { name: "Marcar como perdido" });
    expect(movesEnviados()).toHaveLength(0);

    const motivo = janela.querySelector<HTMLInputElement>('input[type="radio"]')!;
    await user.click(motivo);
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(movesEnviados()).toHaveLength(1));
    expect(movesEnviados()[0]?.corpo).toMatchObject({ stage_id: "s-3", lost_reason: motivo.value });
  });

  it("a recusa de campos obrigatórios abre a janela de campos do quadro", async () => {
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
    await abrirDossieDoMovido(user);
    await user.click(screen.getByRole("button", { name: "dossiê → Contato" }));

    expect(await screen.findByRole("dialog", { name: "Campos obrigatórios" })).toBeTruthy();
  });
});

describe("o dossiê real monta o seletor com esse fio", () => {
  // Complemento, não prova: o comportamento está nos blocos de cima. Isto só
  // pega o dossiê deixando de montar o seletor ou de usar a régua do arrasto.
  const dossie = readFileSync("components/kanban/LeadDossier.tsx", "utf8");

  it("passa onMudarEtapa ao seletor, com a permissão de mover card", () => {
    expect(dossie).toMatch(/<EtapaNoDossie[\s\S]*?onMudar=\{onMudarEtapa\}/);
    expect(dossie).toMatch(/usePermission\("pipeline\.move_card"\)/);
  });
});
