/**
 * As caixas de seleção da lista de Contatos seguem o MESMO portão da barra de
 * lote (#2484, F3). Medido na prova pela tela do #2913: o viewer via 25 caixas
 * de linha e o "selecionar todas", marcava, e nenhuma barra aparecia — um
 * controle que não leva a nada.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContactsListClient } from "@/app/app/contacts/_client";
import type { Contact } from "@/lib/types/contacts";

let podeEditar = true;

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", role: "viewer", cliente_pela_agenda: false }),
  usePermission: () => podeEditar,
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/channels/SeletorDeCanalParaConversa", () => ({
  useConversaNovaComEscolhaDeCanal: () => ({ iniciarConversa: vi.fn(), abrindo: false, seletor: null }),
}));
vi.mock("@/components/contacts/EditContactDialog", () => ({ EditContactDialog: () => null }));
vi.mock("@/components/contacts/NewContactDialog", () => ({ NewContactDialog: () => null }));
vi.mock("@/components/contacts/ImportContactsDialog", () => ({ ImportContactsDialog: () => null }));
vi.mock("@/components/contacts/MergeDialog", () => ({ MergeDialog: () => null }));

const CONTATO = {
  id: "c-1",
  organization_id: "org-1",
  name: "Joana Prado",
  display_name: null,
  email: null,
  email_normalized: null,
  phone_number: null,
  cpf_hash: null,
  birthdate: null,
  is_blocked: false,
  is_personal: false,
  blocked_reason: null,
  is_anonymized: false,
  anonymized_at: null,
  is_merged_into: null,
  merged_at: null,
  consent: {},
  tags: [],
  source: "manual",
  source_metadata: {},
  custom_fields: {},
  created_at: "2026-01-01T10:00:00.000Z",
  updated_at: "2026-01-01T10:00:00.000Z",
  last_activity_at: null,
  first_service_at: null,
  ai_opt_out: false,
} satisfies Contact;

vi.mock("@/hooks/contacts/useContactList", () => ({
  useContactList: () => ({
    isLoading: false,
    isError: false,
    data: { pages: [{ data: [CONTATO, { ...CONTATO, id: "c-2", name: "Rui Lima" }] }] },
    hasNextPage: false,
  }),
}));

function renderLista() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ContactsListClient />
    </QueryClientProvider>,
  );
}

const caixas = () => screen.queryAllByRole("checkbox", { name: /^Selecionar/ });

beforeEach(() => {
  podeEditar = true;
});

describe("caixas de seleção da lista de contatos", () => {
  it("quem pode editar vê uma caixa por linha mais o 'selecionar todas'", () => {
    renderLista();
    // Controle positivo: a consulta acha as caixas quando elas existem, então
    // o zero do caso de baixo é ausência, e não sonda cega.
    expect(caixas()).toHaveLength(3);
  });

  it("sem contact.update (viewer), nenhuma caixa — nem de linha, nem 'todas'", () => {
    podeEditar = false;
    renderLista();
    expect(screen.getByText("Joana Prado")).toBeInTheDocument();
    expect(caixas()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Selecionar todos os contatos visíveis" })).toBeNull();
  });

  // Abaixo de `md` o cabeçalho da tabela some (lista em cartão), e com ele a
  // caixa "selecionar todas": o botão é a porta que a substitui.
  it("o botão 'Selecionar todos' do celular marca todas as linhas", async () => {
    const user = userEvent.setup();
    renderLista();
    await user.click(screen.getByRole("button", { name: "Selecionar todos os contatos visíveis" }));
    expect(caixas()).toHaveLength(3);
    for (const caixa of caixas()) expect(caixa).toHaveAttribute("aria-checked", "true");
  });
});
