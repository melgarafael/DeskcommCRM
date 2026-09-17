/**
 * COM A REGRA DESLIGADA, A TELA NÃO FALA DE CLIENTE.
 *
 * `contacts.first_service_at` só é mantida enquanto a organização tem
 * "Clientes pela agenda" ligada (migration 0262). Desligada, a coluna fica
 * congelada no que era — e um selo "Cliente", uma linha "Cliente desde" ou um
 * botão "Funil de clientes" mostrados a partir dela falariam de uma regra que
 * não roda. Cada consumidor lê a regra por `ActiveOrg.cliente_pela_agenda`, que
 * o layout monta; esta suíte prova os dois estados em cada um.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContactDetailClient } from "@/app/app/contacts/[id]/_client";
import { ContactsListClient } from "@/app/app/contacts/_client";
import { ContactsTable } from "@/components/contacts/ContactsTable";
import { FunisClient } from "@/app/app/kanban/_client";
import type { Contact } from "@/lib/types/contacts";

let ligada = false;
const ORG = { orgId: "org-1", name: "Clínica", role: "admin", cliente_pela_agenda: false };
const USER = { id: "u-1", is_platform_admin: false, support: null };

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ ...ORG, cliente_pela_agenda: ligada }),
  useAuth: () => ({ user: USER, activeOrg: { ...ORG, cliente_pela_agenda: ligada } }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/hooks/contacts/useContact", () => ({
  useContact: () => ({ isLoading: false, isError: false, data: { data: CONTATO }, refetch: vi.fn() }),
}));
vi.mock("@/hooks/pipelines/useDefaultPipeline", () => ({ useDefaultPipeline: () => ({ data: null }) }));
vi.mock("@/components/contacts/TimelineView", () => ({ TimelineView: () => null }));
vi.mock("@/components/contacts/EditContactDialog", () => ({ EditContactDialog: () => null }));
vi.mock("@/components/contacts/AnonymizeDialog", () => ({ AnonymizeDialog: () => null }));
vi.mock("@/components/contacts/PropostasDeDado", () => ({ PropostasDeDado: () => null }));
vi.mock("@/components/kanban/ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("@/components/voice/DialButton", () => ({ DialButton: () => null }));
vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: () => ({
    isLoading: false,
    isError: false,
    // Nenhum contato carregado tem etiqueta: a única opção possível é a fixa.
    data: { pages: [{ data: [{ ...CONTATO, tags: [] }] }] },
    hasNextPage: false,
  }),
}));
vi.mock("@/components/contacts/NewContactDialog", () => ({ NewContactDialog: () => null }));
vi.mock("@/components/contacts/ImportContactsDialog", () => ({ ImportContactsDialog: () => null }));
vi.mock("@/components/contacts/MergeDialog", () => ({ MergeDialog: () => null }));
vi.mock("@/hooks/pipelines/usePipelines", () => ({
  useCriarFunil: () => ({ isPending: false, mutate: vi.fn() }),
  useEditarFunil: () => ({ isPending: false, mutate: vi.fn() }),
  useArquivarFunil: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock("@/app/app/kanban/_components/ImportarLeads", () => ({ ImportarLeads: () => null }));

const CONTATO = {
  id: "c-1",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: "Joana",
  email: null,
  email_normalized: null,
  phone_number: null,
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  blocked_reason: null,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: [],
  source: "whatsapp",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-01-01T10:00:00.000Z",
  updated_at: "2026-01-01T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: "2025-03-12T14:00:00.000Z",
} satisfies Contact;

function comQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  ligada = false;
});

describe("selo 'Cliente' na lista de contatos", () => {
  it("desligada: contato com data congelada NÃO ganha selo", () => {
    render(comQuery(<ContactsTable contacts={[CONTATO]} orderBy="last_activity_at" orderDir="desc" onSort={() => {}} />));
    expect(screen.queryByText("Cliente")).toBeNull();
  });

  it("ligada: o mesmo contato ganha selo", () => {
    ligada = true;
    render(comQuery(<ContactsTable contacts={[CONTATO]} orderBy="last_activity_at" orderDir="desc" onSort={() => {}} />));
    expect(screen.getByText("Cliente")).toBeInTheDocument();
  });
});

describe("'Cliente desde' na ficha do contato", () => {

  it("desligada: a linha não aparece", () => {
    render(comQuery(<ContactDetailClient contactId="c-1" />));
    // O controle de vacuidade prende o ELEMENTO, não o texto: a ficha mostra o
    // nome DUAS vezes de propósito — o `<h1>` do cabeçalho e um campo do card
    // de visão geral —, então procurar por texto solto é ambíguo por
    // construção. Só não era antes do PR #907 por acaso: `rotuloDoContato`
    // preferia `display_name`, o `<h1>` saía "Joana", e a string procurada
    // aqui ("Joana Prado", que é o `name`) casava apenas com o campo "Nome".
    // Medido nos dois lados com esta mesma ficha: na v1.28.0, `h1="Joana"`,
    // "Joana" x2 e "Joana Prado" x1; com o #907, `h1="Joana Prado"`, "Joana
    // Prado" x2 e "Joana" x1. A repetição na TELA é a mesma — o título sempre
    // espelha um dos dois campos —, o que mudou foi qual deles.
    //
    // A consulta também não crava QUAL nome vence: o que este arquivo vigia é
    // "Clientes pela agenda", e amarrar aqui a precedência do #907 faria o
    // teste reprovar por um assunto que não é o dele. O que o controle precisa
    // provar segue provado — a ficha deste contato renderizou, logo o
    // `queryByText` abaixo ser nulo significa que a linha não está lá, e não
    // que a tela está vazia.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Joana");
    expect(screen.queryByText("Cliente desde")).toBeNull();
  });

  it("ligada: a linha aparece com a data", () => {
    ligada = true;
    render(comQuery(<ContactDetailClient contactId="c-1" />));
    expect(screen.getByText("Cliente desde")).toBeInTheDocument();
    expect(screen.getByText("12/03/2025")).toBeInTheDocument();
  });
});

describe("opção fixa 'cliente' no filtro de etiquetas", () => {

  const botaoDeTag = () => screen.getByRole("button", { name: /^Tag:/ });

  it("desligada: sem etiquetas carregadas, o filtro fica sem opção (desabilitado)", () => {
    render(comQuery(<ContactsListClient />));
    expect(botaoDeTag()).toBeDisabled();
  });

  it("ligada: 'cliente' está sempre lá, então o filtro abre", () => {
    ligada = true;
    render(comQuery(<ContactsListClient />));
    expect(botaoDeTag()).toBeEnabled();
  });
});

describe("funil de clientes na tela de Funis", () => {

  const FUNIS = [
    { id: "f1", name: "Entrada", slug: "entrada", description: null, position: 1, is_default: true, is_client_pipeline: false },
    { id: "f2", name: "Clientes", slug: "clientes", description: null, position: 2, is_default: false, is_client_pipeline: true },
  ];

  it("desligada: sem botão, sem selo 'Clientes', e o rodapé aponta onde ligar", () => {
    render(comQuery(<FunisClient funis={FUNIS} podeGerenciar podeImportar />));
    expect(screen.queryByTestId("clientes-f1")).toBeNull();
    expect(screen.queryByTestId("clientes-f2")).toBeNull();
    // "Clientes" é também o NOME do funil f2: o selo é o SEGUNDO texto igual.
    expect(screen.getAllByText("Clientes")).toHaveLength(1);
    expect(screen.getByTestId("funis-rodape-clientes")).toHaveTextContent(
      "Para separar quem já é cliente, ligue “Clientes pela agenda” em Configurações › Tipos de agendamento.",
    );
    expect(screen.getByTestId("funis-rodape-ligar")).toHaveAttribute("href", "/app/settings/tenant/agenda");
  });

  it("ligada: botão em cada funil, selo no marcado, e o rodapé do roteamento", () => {
    ligada = true;
    render(comQuery(<FunisClient funis={FUNIS} podeGerenciar podeImportar />));
    expect(screen.getByTestId("clientes-f1")).toHaveTextContent("Funil de clientes");
    expect(screen.getByTestId("clientes-f2")).toHaveTextContent("Deixar de ser funil de clientes");
    expect(screen.getAllByText("Clientes")).toHaveLength(2);
    expect(screen.getByTestId("funis-rodape-clientes")).toHaveTextContent(
      "Quem já tem atendimento marcado entra pelo funil de clientes.",
    );
  });
});
