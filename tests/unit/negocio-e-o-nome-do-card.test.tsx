/**
 * UM NOME SÓ PARA O CARD: "NEGÓCIO" (#3811).
 *
 * ─── O defeito que este arquivo prende ─────────────────────────────────────
 *
 * O MESMO objeto tinha dois nomes na tela. O aviso de duplicidade do diálogo já
 * dizia "negócio" ("Este contato já tem um negócio aberto neste funil"), e os
 * comentários do próprio `NewLeadDialog` também — mas o diálogo de criação se
 * chamava "Novo Lead", o toast dizia "Lead criado", o botão "Criar lead" e o
 * quadro vazio "Nenhum lead nesta pipeline ainda.". Quem opera o funil lia
 * "lead" onde o produto já falava "negócio", e "pipeline" onde o menu já diz
 * "Funis".
 *
 * A issue pede UM nome, e a decisão de produto (no PR #3820) é a palavra que
 * o produto já fala em mais de cem textos: **Negócio**. "Lead" continua
 * valendo só para a PESSOA entrando (contato novo) — nada aqui renomeia
 * tabela, coluna, rota, tipo TS, `data-testid` nem chave de i18n existente.
 *
 * ─── O que este arquivo prova, e COMO ──────────────────────────────────────
 *
 *  1. o texto EXIBIDO pelo diálogo, pelo botão, pelo toast, pelo card e pelo
 *     quadro vazio sai como "negócio" — lido por RENDER (Testing Library),
 *     não por grep no arquivo;
 *  2. o texto vem da FONTE ÚNICA (`lib/i18n/dicionario.ts`): o mesmo diálogo
 *     renderizado em espanhol mostra "Nuevo negocio". Se alguém voltar a
 *     escrever o texto em duro no JSX, o português continua verde e é esta
 *     asserção que fica vermelha;
 *  3. nenhum texto PT do funil diz "pipeline" — o nome é "funil";
 *  4. a lista `TEXTOS_DO_CARD` congela o vocabulário: cada frase é chave do
 *     dicionário, tem espanhol e diz "negócio".
 */
import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { buildCardInput } from "@/lib/kanban/card-state";
import type { Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { KanbanCard } from "@/components/kanban/KanbanCard";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ currency: "BRL", country: null, role: "agent", orgId: "org-1" }),
  useAuth: () => ({ user: { id: "usuario-eu" } }),
  usePermission: () => true,
  useUser: () => ({ id: "usuario-eu" }),
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/kanban/useAssignableAgents", () => ({ useAssignableAgents: () => ({ data: [] }) }));
vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: () => ({ data: null }) }));
vi.mock("@/hooks/leads/useReactivations", () => ({ useReactivations: () => ({ data: [] }) }));
// Os diálogos do menu de ações não fazem parte desta medida (o que se lê aqui é
// o RÓTULO do card e do menu): dublados, não arrastam rota, org e moeda para o
// caso — o mesmo recorte de `KanbanCard.densidade.test.tsx`.
vi.mock("@/components/kanban/EditLeadDialog", () => ({ EditLeadDialog: () => null }));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({ LoseLeadDialog: () => null }));
vi.mock("@/components/kanban/MoveToOtherPipelineDialog", () => ({
  MoveToOtherPipelineDialog: () => null,
}));
vi.mock("@/hooks/kanban/useUpdateLead", () => ({
  useWinLead: () => ({ mutate: vi.fn(), isPending: false }),
  useEditLead: () => ({ mutate: vi.fn(), isPending: false }),
  useLoseLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(async () => ({ data: [] })),
    post: vi.fn(async () => ({ data: null })),
    patch: vi.fn(async () => ({ data: null })),
  },
}));

const FUNIL = "11111111-1111-4111-8111-111111111111";
const ETAPA = "22222222-2222-4222-8222-222222222222";

const STAGE: Stage = {
  id: ETAPA,
  organization_id: "org-1",
  pipeline_id: FUNIL,
  name: "Novo",
  slug: "novo",
  position: 0,
  color: null,
  is_won: false,
  is_lost: false,
  is_archived: false,
  expected_duration_hours: null,
};

const LEAD = {
  id: "l-1",
  title: "Proposta da ACME — renovação anual de contrato",
  value_cents: 250_000,
  currency: "BRL",
  tags: [],
  stage_changed_at: "2026-10-22T12:00:00Z",
  created_at: "2026-10-22T12:00:00Z",
  owner_kind: "user",
  owner_user_id: "u-1",
  owner_agent_id: null,
  owner_agent: null,
  owner_user: { full_name: "Marcos" },
  next_action: null,
  score: null,
  contact_id: "c-1",
  contact_phone: "+55 11 98888-7777",
  contact_email: "ana@exemplo.com",
  contact_links: [],
  conversa: null,
  tarefas: [],
} as unknown as Lead;

/**
 * O vocabulário do card, frase por frase — é ele que a issue congela.
 *
 * A chave é o texto em português, como em todo o produto: o valor do dicionário
 * é a MESMA frase, então `traduzir(k, "pt-BR") === k` e a tela nunca escreve
 * uma frase que não esteja na fonte única.
 */
const TEXTOS_DO_CARD = [
  "Novo negócio",
  "Abra um negócio para um contato neste funil.",
  "Negócio criado",
  "Criar negócio",
  "Sem contato, este negócio não recebe WhatsApp nem entra nas automações.",
  "Nenhum negócio neste funil ainda.",
  "Negócio",
  "Ações do negócio",
  "Editar negócio",
  "Negócio atualizado",
  "Salve o negócio antes de anexar arquivos.",
  "Negócios recentes",
  "Sem negócios.",
] as const;

function cliente() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function montarDialogo(idioma: "pt-BR" | "es" = "pt-BR") {
  return render(
    <QueryClientProvider client={cliente()}>
      <IdiomaProvider locale={idioma}>
        <NewLeadDialog open onOpenChange={() => undefined} pipelineId={FUNIL} stages={[STAGE]} leads={[]} />
      </IdiomaProvider>
    </QueryClientProvider>,
  );
}

function montarCard(idioma: "pt-BR" | "es" = "pt-BR") {
  const card = buildCardInput(LEAD, {
    stageName: "Negociação",
    ownerNames: new Map([["u-1", "Marcos"]]),
    coolingIds: new Set<string>(),
    reactivations: new Map(),
    canonicalTags: [],
    now: new Date("2026-10-27T12:00:00Z"),
  });
  return render(
    <QueryClientProvider client={cliente()}>
      <IdiomaProvider locale={idioma}>
        <DragDropContext onDragEnd={() => undefined}>
          <Droppable droppableId="etapa-1" type="LEAD">
            {() => (
              <div>
                <KanbanCard card={card} lead={LEAD} index={0} pipelineId={FUNIL} etapas={[STAGE]} />
              </div>
            )}
          </Droppable>
        </DragDropContext>
      </IdiomaProvider>
    </QueryClientProvider>,
  );
}

function montarQuadroVazio(idioma: "pt-BR" | "es" = "pt-BR") {
  return render(
    <QueryClientProvider client={cliente()}>
      <IdiomaProvider locale={idioma}>
        <KanbanBoard pipelineId={FUNIL} stages={[]} leads={[]} />
      </IdiomaProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(toastMock).forEach((f) => f.mockReset());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("o funil chama o card de NEGÓCIO (#3811)", () => {
  it("o diálogo de criação: título, subtítulo, botão e texto sem contato", () => {
    const { container } = montarDialogo();

    expect(screen.getByRole("dialog", { name: "Novo negócio" })).toBeInTheDocument();
    expect(
      screen.getByText("Abra um negócio para um contato neste funil."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Criar negócio" })).toBeInTheDocument();
    expect(
      screen.getByText("Sem contato, este negócio não recebe WhatsApp nem entra nas automações."),
    ).toBeInTheDocument();

    // O nome ANTIGO e a palavra "pipeline" não aparecem em NENHUM texto da tela.
    expect(container.textContent).not.toMatch(/lead/i);
    expect(container.textContent).not.toMatch(/pipeline/i);
  });

  it("em espanhol o MESMO diálogo mostra o texto do dicionário (fonte única)", () => {
    montarDialogo("es");

    expect(screen.getByRole("dialog", { name: "Nuevo negocio" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear negocio" })).toBeInTheDocument();
  });

  it("o toast de criação diz 'Negócio criado'", async () => {
    const user = userEvent.setup();
    montarDialogo();

    await user.type(screen.getByLabelText("Título"), "Renovação ACME");
    await user.click(screen.getByRole("button", { name: "Criar negócio" }));

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Negócio criado"));
  });

  it("o card se anuncia como 'Negócio: <título>' e o menu como 'Ações do negócio'", () => {
    const { container } = montarCard();

    const cartao = screen.getByRole("group", { name: /^Negócio: / });
    expect(cartao.getAttribute("aria-label")).toBe(`Negócio: ${LEAD.title}`);
    expect(screen.getByRole("button", { name: "Ações do negócio" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/pipeline/i);
  });

  it("o quadro vazio diz 'Nenhum negócio neste funil ainda.'", () => {
    const { container } = montarQuadroVazio();

    expect(screen.getByText("Nenhum negócio neste funil ainda.")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/pipeline/i);
  });

  it("a lista de textos do card é toda do dicionário, com espanhol, e sem 'pipeline'", () => {
    const semEspanhol = TEXTOS_DO_CARD.filter((texto) => !DICIONARIO[texto]?.es);
    expect(semEspanhol, `textos do card sem espanhol: ${semEspanhol.join(" | ")}`).toEqual([]);

    const comPipeline = TEXTOS_DO_CARD.filter((texto) => /pipeline/i.test(texto));
    expect(comPipeline, `textos do card ainda dizem "pipeline": ${comPipeline.join(" | ")}`).toEqual(
      [],
    );

    // O nome é UM só: toda frase do card diz "negócio", e o português é a
    // própria chave (`traduzir` devolver outra coisa significaria dicionário
    // mentindo sobre o que a tela mostra).
    const semONome = TEXTOS_DO_CARD.filter((texto) => !/negócio/i.test(texto));
    expect(semONome, `textos do card sem o nome novo: ${semONome.join(" | ")}`).toEqual([]);

    const ptDivergente = TEXTOS_DO_CARD.filter((texto) => traduzir(texto, "pt-BR") !== texto);
    expect(ptDivergente).toEqual([]);
  });
});
