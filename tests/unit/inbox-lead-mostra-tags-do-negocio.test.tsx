import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

/**
 * As tags do NEGÓCIO aparecem na conversa, só para ler.
 *
 * O defeito: um fluxo de acompanhamento ou uma automação pode decidir pela tag
 * do NEGÓCIO (a condição de etiqueta lê `crm_leads.tags`). Quem atendia abria a
 * conversa, via "Tags do contato" e "Tags da conversa" vazias e concluía que a
 * tag não existia — ela só aparecia no dossiê do quadro.
 */

const CONTACT = "c0000000-0000-4000-8000-000000000001";

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTACT,
  tags: [],
  contacts: { id: CONTACT, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

function leadRow(id: string, tags: string[] | null) {
  return {
    id, title: "Felipe", status: "open", value_cents: null, currency: null,
    updated_at: "2026-09-15T12:00:00Z", pipeline_id: `p-${id}`, custom_fields: {}, field_defs: [],
    funil_nome: "Vendas", etapa_nome: "Proposta enviada", tags,
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
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [] }),
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

describe("painel do inbox — tags do negócio", () => {
  it("com um negócio só, mostra as tags do negócio junto de funil e etapa", async () => {
    get.mockResolvedValue(resposta([leadRow("l-1", ["cliente-vip", "tenis-corrida-01"])]));
    renderPainel();

    const linha = await screen.findByTestId("inbox-lead-unico");
    const tags = within(linha).getByTestId("inbox-lead-tags");
    expect(tags.textContent).toContain("tenis-corrida-01");
    expect(tags.textContent).toContain("cliente-vip");
  });

  it("com vários negócios, cada um mostra as SUAS tags", async () => {
    get.mockResolvedValue(resposta([leadRow("l-1", ["tenis-corrida-01"]), leadRow("l-2", ["ventilador-mesa-02"])]));
    renderPainel();

    const um = await screen.findByTestId("inbox-lead-l-1");
    const dois = screen.getByTestId("inbox-lead-l-2");
    expect(within(um).getByTestId("inbox-lead-tags").textContent).toContain("tenis-corrida-01");
    expect(um.textContent).not.toContain("ventilador-mesa-02");
    expect(within(dois).getByTestId("inbox-lead-tags").textContent).toContain("ventilador-mesa-02");
  });

  it("negócio sem tags (ou tags nulas) não desenha a linha vazia", async () => {
    get.mockResolvedValue(resposta([leadRow("l-1", null)]));
    renderPainel();

    await screen.findByTestId("inbox-lead-unico");
    expect(screen.queryByTestId("inbox-lead-tags")).toBeNull();
  });

  it("a rota do painel traz a coluna tags do negócio", () => {
    const rota = readFileSync("app/api/v1/contacts/[id]/crm-summary/route.ts", "utf8");
    const cols = rota.match(/const LEAD_COLS =\s*\n?\s*"([^"]+)"/)?.[1] ?? "";
    expect(cols.split(",").map((c) => c.trim())).toContain("tags");
  });
});
