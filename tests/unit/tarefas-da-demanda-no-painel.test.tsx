import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";
import type { Role } from "@/lib/auth/types";

/**
 * O QUE O PAINEL DECIDE sobre a seção "Tarefas desta demanda" (#2842).
 *
 * A seção em si é medida em `tarefa-da-demanda-no-inbox.test.tsx`. Aqui fica o
 * que só o painel sabe, e que a prova de tela reprovou:
 *
 *  (A) QUEM pode criar — `agent`+, a régua da rota. O painel passava
 *      `!readonly`, que só vale para o suporte somente-leitura: o `viewer` via
 *      "Nova tarefa", preenchia, salvava e levava 403.
 *  (B) QUAL demanda — só a vigente que ainda está ABERTA. `current_demanda_id`
 *      segue apontando a demanda depois de "Encerrar demanda", e a seção ficava
 *      oferecendo "Nova tarefa" ao lado de "Nenhuma demanda aberta".
 *
 * A seção vira um dublê que expõe as props que recebeu: o alvo é a DECISÃO do
 * painel, não o desenho da seção.
 */

vi.mock("@/components/inbox/TarefasDaDemanda", () => ({
  TarefasDaDemanda: ({ demandaId, podeEditar }: { demandaId: string | null; podeEditar: boolean }) =>
    demandaId ? (
      <div data-testid="duble-tarefas" data-demanda={demandaId} data-pode-editar={String(podeEditar)} />
    ) : null,
}));

const CONTACT = "c0000000-0000-4000-8000-000000000001";
const VIGENTE = "d0000000-0000-4000-8000-000000000001";

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTACT,
  current_demanda_id: VIGENTE,
  tags: [],
  contacts: { id: CONTACT, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

const DEMANDA_ABERTA = {
  id: VIGENTE,
  revision: 1,
  aberta_em: new Date(Date.now() - 3_600_000).toISOString(),
  origem: "inbound",
  estado: "aberta",
  proximo_passo: "Ligar amanhã",
  proximo_passo_em: null,
  prazo_em: null,
};

const resposta = (demandas: unknown[]) => ({
  data: { leads: [], orders: [], activities: [], demandas, fatos: [], historico: [] },
});

const get = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: (...args: unknown[]) => get(...args), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({
  useDefaultPipeline: () => ({ data: null, isError: false }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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

const sessao = vi.hoisted(() => ({ papel: "agent" as Role }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-1", is_platform_admin: false, support: null },
    activeOrg: { orgId: "org-1", role: sessao.papel },
  }),
}));

function renderPainel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CRMSidePanel conversation={conversation} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  sessao.papel = "agent";
});

describe("painel do inbox — a seção de tarefas da demanda (#2842)", () => {
  it("(A) ⭐ viewer vê a seção, mas sem poder criar", async () => {
    sessao.papel = "viewer";
    get.mockResolvedValue(resposta([DEMANDA_ABERTA]));
    renderPainel();

    const secao = await screen.findByTestId("duble-tarefas");
    expect(secao.getAttribute("data-pode-editar")).toBe("false");
  });

  it("(A) agent cria", async () => {
    get.mockResolvedValue(resposta([DEMANDA_ABERTA]));
    renderPainel();

    const secao = await screen.findByTestId("duble-tarefas");
    expect(secao.getAttribute("data-pode-editar")).toBe("true");
  });

  it("(B) ⭐ demanda vigente ENCERRADA: a seção some, junto com 'Nenhuma demanda aberta'", async () => {
    // A conversa ainda aponta VIGENTE, mas a lista de abertas já não a traz.
    get.mockResolvedValue(resposta([]));
    renderPainel();

    const demandas = await screen.findByTestId("inbox-demandas");
    await waitFor(() => expect(demandas.textContent).toMatch(/nenhuma demanda aberta/i));
    expect(screen.queryByTestId("duble-tarefas")).toBeNull();
  });

  it("(B) demanda vigente ABERTA: a seção aparece presa a ela", async () => {
    get.mockResolvedValue(resposta([DEMANDA_ABERTA]));
    renderPainel();

    const secao = await screen.findByTestId("duble-tarefas");
    expect(secao.getAttribute("data-demanda")).toBe(VIGENTE);
  });
});
