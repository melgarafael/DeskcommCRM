// app/app/radar/_components/RiskRadarList.test.tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RiskRadarList, destinoDaDemandaSemPasso } from "./RiskRadarList";
import { useAtRiskLeads } from "@/hooks/leads/useAtRiskLeads";

vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({
  useClaimConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

const BASE = {
  items: [],
  counts: { critico: 0, em_risco: 0, em_voo: 0 },
  total: 0,
  sem_proximo_passo: [],
  total_sem_proximo_passo: 0,
  propostas_vencidas_sem_retomada: [],
};

describe("RiskRadarList — propostas vencidas sem retomada (N3)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lista populada: mostra a seção nova com link para a proposta", async () => {
    vi.mocked(useAtRiskLeads).mockReturnValue({
      data: {
        ...BASE,
        propostas_vencidas_sem_retomada: [
          { lead_id: "lead-1", proposal_id: "prop-1", numero: 42, ano: 2026, valid_until: "2026-10-01" },
        ],
      },
      isLoading: false,
    } as never);
    render(<RiskRadarList />);
    expect(await screen.findByTestId("radar-propostas-vencidas")).toBeInTheDocument();
    expect(screen.getByText(/0042\/2026/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /0042\/2026/ })).toHaveAttribute("href", "/app/proposals/prop-1");
  });

  it("lista vazia: esconde a seção", async () => {
    vi.mocked(useAtRiskLeads).mockReturnValue({
      data: { ...BASE, sem_proximo_passo: [{ id: "d1", contact_id: "c1", contact_name: "X", aberta_em: "2026-01-01", horas_aberta: 5, origem: "y", conversation_id: null }] },
      isLoading: false,
    } as never);
    render(<RiskRadarList />);
    expect(screen.queryByTestId("radar-propostas-vencidas")).not.toBeInTheDocument();
  });

  it("só há proposta vencida (sem lead frio nem demanda): NÃO mostra o vazio", async () => {
    vi.mocked(useAtRiskLeads).mockReturnValue({
      data: {
        ...BASE,
        propostas_vencidas_sem_retomada: [
          { lead_id: "lead-1", proposal_id: "prop-1", numero: null, ano: null, valid_until: null },
        ],
      },
      isLoading: false,
    } as never);
    render(<RiskRadarList />);
    expect(screen.queryByTestId("radar-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("radar-propostas-vencidas")).toBeInTheDocument();
  });
});

describe("RiskRadarList — demanda sem próximo passo clicável (#2035 · Parte 1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("item VIRA LINK para a conversa vigente quando ela existe", async () => {
    vi.mocked(useAtRiskLeads).mockReturnValue({
      data: {
        ...BASE,
        sem_proximo_passo: [
          {
            id: "d1",
            contact_id: "c1",
            contact_name: "Ana",
            aberta_em: "2026-09-01T00:00:00Z",
            horas_aberta: 30,
            origem: "handoff",
            conversation_id: "conv-1",
          },
        ],
      },
      isLoading: false,
    } as never);
    render(<RiskRadarList />);
    expect(await screen.findByTestId("radar-sem-passo-link")).toHaveAttribute(
      "href",
      "/app/inbox?id=conv-1",
    );
  });

  it("sem conversa, o item VIRA LINK para a ficha do contato", async () => {
    vi.mocked(useAtRiskLeads).mockReturnValue({
      data: {
        ...BASE,
        sem_proximo_passo: [
          {
            id: "d2",
            contact_id: "c2",
            contact_name: "Bruno",
            aberta_em: "2026-09-01T00:00:00Z",
            horas_aberta: 30,
            origem: "inbound",
            conversation_id: null,
          },
        ],
      },
      isLoading: false,
    } as never);
    render(<RiskRadarList />);
    expect(await screen.findByTestId("radar-sem-passo-link")).toHaveAttribute(
      "href",
      "/app/contacts/c2",
    );
  });

  it("o resolver puro escolhe inbox se há conversa, ficha se não há", () => {
    expect(destinoDaDemandaSemPasso({ contact_id: "c1", conversation_id: "conv-9" })).toBe(
      "/app/inbox?id=conv-9",
    );
    expect(destinoDaDemandaSemPasso({ contact_id: "c1", conversation_id: null })).toBe(
      "/app/contacts/c1",
    );
  });
});

describe("#3062 — o item SEM conversa abre o quadro do funil JÁ com o negócio", () => {
  beforeEach(() => vi.clearAllMocks());

  // A linha do radar chama `useQueryClient` (é ela que invalida a lista ao
  // assumir uma demanda), então precisa de um provider próprio.
  const renderRadar = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RiskRadarList />
      </QueryClientProvider>,
    );

  const SEM_CONVERSA = {
    id: "lead-7",
    title: "Orçamento parado",
    contact_id: "c7",
    contact_name: "Ana",
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    owner_agent_name: null,
    assignee_kind: null,
    last_activity_at: null,
    hours_since_activity: 72,
    risk: "critico",
    in_flight: false,
    next_followup_at: null,
    conversation_id: null,
    pipeline_id: "p-42",
  };

  it("o link leva ao quadro do funil certo e com o `?lead=` do negócio", async () => {
    // Antes o destino era `/app/pipelines/p-42` puro: abria o quadro certo, mas
    // no card errado — a pessoa tinha de procurar o negócio entre as colunas.
    vi.mocked(useAtRiskLeads).mockReturnValue({
      data: { ...BASE, items: [SEM_CONVERSA], total: 1 },
      isLoading: false,
    } as never);
    renderRadar();
    const linha = await screen.findByTestId("radar-item");
    expect(within(linha).getByRole("link", { name: /Orçamento parado/ })).toHaveAttribute(
      "href",
      "/app/pipelines/p-42?lead=lead-7",
    );
  });

  it("no celular, sem ação nenhuma a faixa de ações some em vez de sobrar vazia", async () => {
    // A seta é `max-md:hidden`: sem "Assumir" nem compromisso a faixa não tem
    // nada visível no celular, e com `max-md:pb-3` ela somava 12px vazios. O
    // jsdom não calcula layout, então o teste cobra a CLASSE.
    vi.mocked(useAtRiskLeads).mockReturnValue({
      data: { ...BASE, items: [SEM_CONVERSA], total: 1 },
      isLoading: false,
    } as never);
    renderRadar();
    const faixa = (await screen.findByTestId("radar-item")).lastElementChild!;
    expect(faixa.classList.contains("max-md:hidden")).toBe(true);
    expect(faixa.classList.contains("max-md:pb-3")).toBe(false);
  });

  it("no celular, com \"Assumir\" a faixa de ações desce para baixo do título", async () => {
    vi.mocked(useAtRiskLeads).mockReturnValue({
      data: { ...BASE, items: [{ ...SEM_CONVERSA, conversation_id: "conv-7" }], total: 1 },
      isLoading: false,
    } as never);
    renderRadar();
    const linha = await screen.findByTestId("radar-item");
    const faixa = within(linha).getByTestId("radar-claim").parentElement!;
    expect(faixa).toBe(linha.lastElementChild);
    expect(faixa.classList.contains("max-md:hidden")).toBe(false);
    expect(faixa.classList.contains("max-md:pb-3")).toBe(true);
  });

  it("com conversa o destino continua sendo o inbox — o `?lead=` não rouba o caso", async () => {
    vi.mocked(useAtRiskLeads).mockReturnValue({
      data: { ...BASE, items: [{ ...SEM_CONVERSA, conversation_id: "conv-7" }], total: 1 },
      isLoading: false,
    } as never);
    renderRadar();
    const linha = await screen.findByTestId("radar-item");
    expect(within(linha).getByRole("link", { name: /Orçamento parado/ })).toHaveAttribute(
      "href",
      "/app/inbox?id=conv-7",
    );
  });
});