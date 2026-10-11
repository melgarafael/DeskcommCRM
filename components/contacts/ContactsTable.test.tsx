import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContactsTable } from "./ContactsTable";
import type { Contact } from "@/lib/types/contacts";

// Issue #2715 — a linha ganha o atalho de edição: presença e ordem dos ícones,
// e abertura do MESMO diálogo da ficha (EditContactDialog) pré-preenchido.

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ country: "BR", cliente_pela_agenda: false }),
}));
vi.mock("@/components/channels/SeletorDeCanalParaConversa", () => ({
  useConversaNovaComEscolhaDeCanal: () => ({
    iniciarConversa: vi.fn(),
    abrindo: false,
    seletor: null,
  }),
}));
vi.mock("@/hooks/contacts/useDeleteContact", () => ({
  useDeleteContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
  mensagemDeBloqueioPorVinculo: vi.fn(() => "mensagem de bloqueio"),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue({ vinculos: 0, agendamentos: 0 }),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

const contato: Contact = {
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
  name: "Web Speed",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: "+5519936197571",
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  blocked_reason: null,
  is_personal: false,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: ["cliente"],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-10-01T12:00:00.000Z",
  updated_at: "2026-10-01T12:00:00.000Z",
  last_activity_at: "2026-10-10T19:00:00.000Z",
  first_service_at: null,
};

function renderTabela(contacts: Contact[] = [contato]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ContactsTable contacts={contacts} orderBy="display_name" orderDir="asc" onSort={() => {}} />
    </QueryClientProvider>,
  );
}

function linhaDoContato() {
  const nome = screen.getByText("Web Speed");
  return nome.closest("tr") as HTMLElement;
}

describe("ContactsTable — atalho de edição na linha (issue #2715)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("mostra o lápis entre a ação de conversa e a de excluir, nomeando o contato", () => {
    renderTabela();
    const botoes = within(linhaDoContato()).getAllByRole("button");
    const rotulos = botoes.map((b) => b.getAttribute("aria-label"));
    expect(rotulos).toHaveLength(3);
    expect(rotulos[0]).toMatch(/conversa/i);
    expect(rotulos[1]).toBe("Editar contato Web Speed");
    expect(rotulos[2]).toBe("Excluir contato Web Speed");
  });

  it("abre o EditContactDialog pré-preenchido com a linha", async () => {
    const user = userEvent.setup();
    renderTabela();
    await user.click(screen.getByRole("button", { name: "Editar contato Web Speed" }));
    // O mesmo diálogo da ficha: título e campo de nome já com o valor da linha.
    expect(await screen.findByText("Editar contato")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Web Speed")).toBeInTheDocument();
  });

  it("fechar zera o state e o lápis reabre de novo", async () => {
    const user = userEvent.setup();
    renderTabela();
    const botaoEditar = () => screen.getByRole("button", { name: "Editar contato Web Speed" });
    await user.click(botaoEditar());
    await screen.findByText("Editar contato");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText("Editar contato")).not.toBeInTheDocument(),
    );
    await user.click(botaoEditar());
    expect(await screen.findByText("Editar contato")).toBeInTheDocument();
  });

  it("contato anonimizado não ganha o lápis, como na ficha; a linha comum segue tendo", () => {
    const anonimizado: Contact = {
      ...contato,
      id: "00000000-0000-4000-8000-000000000003",
      name: "Cliente Anonimizado #7",
      phone_number: null,
      is_anonymized: true,
      anonymized_at: "2026-10-02T12:00:00.000Z",
    };
    renderTabela([contato, anonimizado]);
    const linhaAnon = screen.getByText("Cliente Anonimizado #7").closest("tr") as HTMLElement;
    expect(within(linhaAnon).queryByRole("button", { name: /Editar contato/ })).toBeNull();
    expect(
      within(linhaDoContato()).getByRole("button", { name: "Editar contato Web Speed" }),
    ).toBeInTheDocument();
  });
});
