import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

/**
 * "Leads recentes" não dizia DE ONDE era cada lead (issue #943). Caso real: o
 * contato tinha dois leads "Felipe", em funis diferentes, e a tela mostrava as
 * duas linhas iguais — "open · —". O operador não tinha como saber qual era qual.
 */

const CONTACT = "c0000000-0000-4000-8000-000000000001";

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTACT,
  tags: [],
  contacts: { id: CONTACT, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

function leadRow(id: string, funil: string, etapa: string, status: string) {
  return {
    id, title: "Felipe", status, value_cents: null, currency: null,
    updated_at: "2026-09-15T12:00:00Z", pipeline_id: `p-${id}`, custom_fields: {}, field_defs: [],
    funil_nome: funil, etapa_nome: etapa,
  };
}

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
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ user: { support: null } }) }));

function renderPainel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CRMSidePanel conversation={conversation} />
    </QueryClientProvider>,
  );
}

function resposta(leads: unknown[]) {
  return { data: { leads, orders: [], activities: [], demandas: [], fatos: [], historico: [] } };
}

beforeEach(() => get.mockReset());

describe("painel do inbox — leads recentes dizem funil, etapa e status traduzido", () => {
  it("dois leads de mesmo título mostram funis diferentes, e 'Aberto' no lugar de 'open'", async () => {
    get.mockResolvedValue(resposta([
      leadRow("l-1", "GMN Advogados", "Novo", "open"),
      leadRow("l-2", "Padrão", "Qualificação", "won"),
    ]));
    renderPainel();

    const um = await screen.findByTestId("inbox-lead-l-1");
    const dois = screen.getByTestId("inbox-lead-l-2");
    expect(um.textContent).toContain("GMN Advogados · Novo");
    expect(um.textContent).toContain("Aberto");
    expect(dois.textContent).toContain("Padrão · Qualificação");
    expect(dois.textContent).toContain("Ganho");
    expect(`${um.textContent}${dois.textContent}`).not.toMatch(/\b(open|won)\b/);
  });

  it("com um lead só, a linha também diz funil, etapa e status traduzido", async () => {
    get.mockResolvedValue(resposta([leadRow("l-1", "GMN Advogados", "Novo", "lost")]));
    renderPainel();

    const linha = await screen.findByTestId("inbox-lead-unico");
    expect(linha.textContent).toContain("GMN Advogados · Novo");
    expect(linha.textContent).toContain("Perdido");
    expect(linha.textContent).not.toMatch(/\blost\b/);
  });
});
