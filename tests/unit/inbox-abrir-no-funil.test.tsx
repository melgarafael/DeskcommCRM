import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * ABRIR O NEGÓCIO NO QUADRO DO FUNIL (issue #3004) — o atalho dentro da conversa.
 *
 * O atendente via o negócio no painel e, para olhar o card no quadro, tinha de
 * sair do Inbox, abrir o funil e procurar o card na mão. A âncora para isso JÁ
 * EXISTIA e é usada por outra porta do produto: `/app/pipelines/<id>?lead=<id>`,
 * o mesmo destino de `app/app/leads/[id]/page.tsx` e de `NewLeadDialog`.
 *
 * Nada de rota nova: o atalho só reusa o `?lead=` com o `pipeline_id` do negócio
 * ATIVO. O que este arquivo prende é o elo que uma mudança de tela pode romper
 * sem barulho: a URL que o painel monta, e o quadro lendo `?lead=`.
 */
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

const get = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
// O portão de "Levar para outro funil" é `pipeline.move_card` (agent+).
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { support: null, is_platform_admin: false },
    activeOrg: { orgId: "org-1", name: "Org", role: "agent" },
  }),
}));
vi.mock("@/components/contacts/RoteirosDoContato", () => ({ RoteirosDoContato: () => null }));

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

const CONTATO = "c0000000-0000-4000-8000-000000000001";

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTATO,
  tags: [],
  contacts: { id: CONTATO, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

const NEGOCIO = {
  id: "l-1",
  title: "Felipe",
  status: "open",
  value_cents: null,
  currency: null,
  updated_at: "2026-09-15T12:00:00Z",
  pipeline_id: "p-1",
  stage_id: "s-1",
  custom_fields: {},
  field_defs: [],
  funil_nome: "Origem",
  etapa_nome: "Novo",
  etapas_do_funil: [{ id: "s-1", name: "Novo", is_won: false, is_lost: false }],
};

function renderPainel(leads: unknown[] = [NEGOCIO]) {
  get.mockResolvedValue({ data: { leads, orders: [], activities: [], demandas: [], fatos: [], historico: [] } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CRMSidePanel conversation={conversation} />
    </QueryClientProvider>,
  );
}

describe("painel do contato — Abrir no funil (#3004)", () => {
  it("aponta para o quadro do funil do negócio ATIVO, com o negócio identificado", async () => {
    renderPainel();

    const atalho = await screen.findByTestId("inbox-abrir-no-funil");
    // Fundir a rota da página com a identificação do card: é o `?lead=` que o
    // quadro lê para abrir o negócio certo (medido em `KanbanBoard.leadInicial`).
    expect(atalho).toHaveAttribute("href", "/app/pipelines/p-1?lead=l-1");
    expect(atalho.textContent).toContain("Abrir no funil");
  });

  it("sem negócio no contato não inventa atalho", async () => {
    renderPainel([]);
    // Controle de vacuidade: o painel desenhou (o cabeçalho do contato está lá).
    expect(await screen.findByText("Fulana")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-abrir-no-funil")).toBeNull();
  });
});

/**
 * O ELO DO OUTRO LADO: a rota do quadro lê `?lead=`.
 *
 * O painel poderia montar a URL perfeita e o quadro ignorá-la — a pessoa cairia
 * num funil qualquer, sem o card, e o atalho seria uma promessa quebrada. Este
 * caso lê o encanamento da página do funil e cobra o repasse do parâmetro.
 */
describe("a rota do funil consome ?lead=", () => {
  it("a página repassa `?lead=` como `leadInicial` para o quadro", () => {
    const fonte = readFileSync("app/app/pipelines/[id]/_client.tsx", "utf8");
    expect(fonte).toMatch(/leadInicial=\{searchParams\.get\("lead"\)\}/);
  });
});
