import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContactsTable } from "./ContactsTable";
import type { Contact } from "@/lib/types/contacts";
import { contrasteNoTema, tokenDaClasse } from "@/tests/setup/contraste-do-utilitario";

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
  cpf_available: false,
  birthdate: null,
  is_blocked: false,
  blocked_reason: null,
  is_personal: false,
  ai_opt_out: false,
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

function renderTabela(
  contacts: Contact[] = [contato],
  selecao?: {
    selecionados?: Set<string>;
    onAlternarSelecao?: (id: string) => void;
    onSelecionarTodosVisiveis?: () => void;
  },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ContactsTable
        contacts={contacts}
        orderBy="display_name"
        orderDir="asc"
        onSort={() => {}}
        {...selecao}
      />
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

// Issue #2484, fatia F3 — a tabela mede a seleção múltipla do lote de contatos.
// O que estes testes prendem: SEM as props de seleção a tabela é exatamente a
// de sempre (nenhuma caixa nasce sozinha); COM elas, cada linha ganha caixa e a
// cabeça marca todos os visíveis de uma vez. A barra de ações em lote mora no
// cliente da página e tem teste próprio — aqui só se mede a seleção.
describe("ContactsTable — seleção múltipla (#2484, F3)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  const outroContato: Contact = {
    ...contato,
    id: "00000000-0000-4000-8000-000000000009",
    name: "Outro Contato",
    tags: [],
  };

  it("sem as props de seleção, nenhuma caixa aparece", () => {
    renderTabela([contato, outroContato]);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("com as props, cada linha ganha caixa e o clique alterna o contato certo", async () => {
    const user = userEvent.setup();
    const onAlternar = vi.fn();
    renderTabela([contato, outroContato], {
      selecionados: new Set([contato.id]),
      onAlternarSelecao: onAlternar,
      onSelecionarTodosVisiveis: vi.fn(),
    });

    const caixaDaWebSpeed = screen.getByTestId(`selecionar-contato-${contato.id}`);
    const caixaDoOutro = screen.getByTestId(`selecionar-contato-${outroContato.id}`);
    // A marca na caixa é lida do estado de seleção, não de um state interno:
    // quem seleciona é a página, e a tabela só desenha o que recebe.
    expect(caixaDaWebSpeed).toHaveAttribute("aria-checked", "true");
    expect(caixaDoOutro).toHaveAttribute("aria-checked", "false");

    await user.click(caixaDoOutro);
    expect(onAlternar).toHaveBeenCalledWith(outroContato.id);
  });

  it("a cabeça marca todos os visíveis de uma vez", async () => {
    const user = userEvent.setup();
    const onSelecionarTodos = vi.fn();
    renderTabela([contato, outroContato], {
      selecionados: new Set(),
      onAlternarSelecao: vi.fn(),
      onSelecionarTodosVisiveis: onSelecionarTodos,
    });

    await user.click(screen.getByTestId("selecionar-todos-contatos"));
    expect(onSelecionarTodos).toHaveBeenCalledTimes(1);
  });

  it("a caixa da linha nomeia o contato, para quem lê a tela pela audição", () => {
    renderTabela([contato], {
      selecionados: new Set(),
      onAlternarSelecao: vi.fn(),
      onSelecionarTodosVisiveis: vi.fn(),
    });
    expect(screen.getByRole("checkbox", { name: "Selecionar contato Web Speed" })).toBeInTheDocument();
  });

  it("a borda da caixa DESMARCADA passa 3:1 contra a linha nos dois temas (WCAG 1.4.11)", () => {
    renderTabela([contato], {
      selecionados: new Set(),
      onAlternarSelecao: vi.fn(),
      onSelecionarTodosVisiveis: vi.fn(),
    });
    // Medido na prova do #2913 com `border-input`: 1.31:1 no escuro (e 1.28:1
    // no claro, calculado) — a caixa sem marca quase sumia na linha.
    for (const caixa of [
      screen.getByTestId(`selecionar-contato-${contato.id}`),
      screen.getByTestId("selecionar-todos-contatos"),
    ]) {
      const borda = tokenDaClasse(caixa.className, "border");
      for (const tema of ["claro", "escuro"] as const) {
        expect(contrasteNoTema(borda, "surface", tema), `${borda} no ${tema}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
