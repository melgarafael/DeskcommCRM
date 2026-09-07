import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CRMSidePanel } from "@/components/inbox/CRMSidePanel";

function renderPainel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CRMSidePanel conversation={conversation} />
    </QueryClientProvider>,
  );
}

const CONTACT = "c0000000-0000-4000-8000-000000000001";

const conversation = {
  id: "cv-1",
  organization_id: "org-1",
  contact_id: CONTACT,
  tags: [],
  contacts: { id: CONTACT, display_name: "Fulana", name: null, phone_number: "5511999", tags: [] },
} as unknown as React.ComponentProps<typeof CRMSidePanel>["conversation"];

const LEAD = {
  id: "l-1",
  title: "Negócio existente",
  status: "open",
  value_cents: 10_000,
  currency: "BRL",
  updated_at: "2026-08-01T00:00:00Z",
  pipeline_id: "p-1",
  description: null,
  tags: [],
  expected_close_date: null,
  custom_fields: { empresa: "ACME" },
  field_defs: [{ key: "empresa", label: "Empresa", type: "text" as const }],
};

const RESPOSTA = {
  leads: [LEAD],
  orders: [],
  activities: [],
  demandas: [],
};

const get = vi.fn();
const patch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    patch: (...args: unknown[]) => patch(...args),
  },
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

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  patch.mockResolvedValue({ data: { ...LEAD } });
});

describe("painel do inbox — campos do lead", () => {
  it("mostra SÓ os campos do funil — título e valor não entram nesta barra", async () => {
    get.mockResolvedValue({ data: RESPOSTA });
    renderPainel();

    const secao = await screen.findByTestId("inbox-campos-lead");
    expect(secao.querySelector("#title")).toBeNull();
    expect(secao.querySelector("#valueReais")).toBeNull();

    const empresa = await screen.findByLabelText("Empresa");
    expect((empresa as HTMLInputElement).value).toBe("ACME");
  });

  it("funil sem campos extras diz isso — não inventa o formulário padrão", async () => {
    get.mockResolvedValue({
      data: { ...RESPOSTA, leads: [{ ...LEAD, field_defs: [] }] },
    });
    renderPainel();

    const secao = await screen.findByTestId("inbox-campos-lead");
    await waitFor(() => expect(secao.textContent).toMatch(/não tem campos extras/i));
    expect(screen.queryByLabelText("Empresa")).toBeNull();
  });

  it("gravar manda o campo customizado no PATCH do lead", async () => {
    get.mockResolvedValue({ data: RESPOSTA });
    renderPainel();

    const empresa = await screen.findByLabelText("Empresa");
    await userEvent.clear(empresa);
    await userEvent.type(empresa, "Nova Co");
    const chamadasAntes = get.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [rota, corpo] = patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(rota).toBe("/api/v1/leads/l-1");
    expect(corpo.custom_fields).toEqual({ empresa: "Nova Co" });
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(chamadasAntes));
  });

  it("dois negócios: trocar o selecionado troca o formulário", async () => {
    get.mockResolvedValue({
      data: {
        ...RESPOSTA,
        leads: [
          LEAD,
          {
            ...LEAD,
            id: "l-2",
            title: "Outro negócio",
            custom_fields: {},
            field_defs: LEAD.field_defs,
          },
        ],
      },
    });
    renderPainel();

    await screen.findByTestId("inbox-lead-l-1");
    expect((screen.getByLabelText("Empresa") as HTMLInputElement).value).toBe("ACME");
    await userEvent.click(screen.getByTestId("inbox-lead-l-2"));
    expect((screen.getByLabelText("Empresa") as HTMLInputElement).value).toBe("");
  });

  it("leitura que FALHA não vira 'Sem leads.'", async () => {
    get.mockRejectedValue(new Error("500"));
    renderPainel();

    const secao = await screen.findByTestId("inbox-campos-lead");
    await waitFor(() => expect(secao.textContent).toMatch(/não consegui ler/i));
    expect(secao.textContent).not.toMatch(/sem leads/i);
  });
});

vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ user: { support: null } }) }));
