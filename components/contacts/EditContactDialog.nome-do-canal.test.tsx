/**
 * Contato sem nome no cadastro: a ficha o chama pelo nome da agenda ou do
 * WhatsApp, e o "Editar contato" abria só com o telefone — lido como formulário
 * que não carregou. Os nomes são oferecidos com um clique, nunca preenchidos
 * sozinhos (o da agenda é só da equipe).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import type { Contact } from "@/lib/types/contacts";

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ country: null }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync, isPending: false }),
}));
vi.mock("@/hooks/tags/useDefinirCorDaEtiqueta", () => ({
  useDefinirCorDaEtiqueta: () => ({ definirCor: vi.fn(async () => true) }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [], isError: false }),
}));

const DO_WHATSAPP = {
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: "22222222-2222-4222-8222-222222222222",
  name: null,
  display_name: "Maria WhatsApp",
  address_book_name: "Maria da Padaria",
  email: null,
  phone_number: "+5511999998888",
  birthdate: null,
  tags: [],
  custom_fields: {},
} as unknown as Contact;

function abrir(contact: Contact) {
  render(<EditContactDialog contact={contact} open onOpenChange={vi.fn()} />);
}
const campoNome = () => screen.getByLabelText("Nome") as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync.mockResolvedValue({});
});

describe("nome do canal no Editar contato", () => {
  it("oferece os dois nomes sem preencher o campo sozinho", () => {
    abrir(DO_WHATSAPP);
    expect(campoNome().value).toBe("");
    expect(screen.getByText(/Maria WhatsApp/)).toBeInTheDocument();
    expect(screen.getByText(/Maria da Padaria/)).toBeInTheDocument();
    expect(screen.getByText(/Só a equipe vê o nome da agenda/)).toBeInTheDocument();
  });

  it("salvar sem escolher não grava nome", async () => {
    const user = userEvent.setup();
    abrir(DO_WHATSAPP);
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0]).not.toHaveProperty("name");
  });

  it("um clique preenche o campo, e o Salvar grava o nome escolhido", async () => {
    const user = userEvent.setup();
    abrir(DO_WHATSAPP);
    await user.click(screen.getByRole("button", { name: "Usar este nome: Maria WhatsApp" }));
    expect(campoNome().value).toBe("Maria WhatsApp");
    expect(screen.queryByRole("button", { name: /Usar este nome/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({ name: "Maria WhatsApp" });
  });

  it("não oferece nada quando o cadastro já tem nome", () => {
    abrir({ ...DO_WHATSAPP, name: "Maria Silva" });
    expect(campoNome().value).toBe("Maria Silva");
    expect(screen.queryByRole("button", { name: /Usar este nome/ })).not.toBeInTheDocument();
  });

  it("não oferece identificador técnico como nome", () => {
    abrir({ ...DO_WHATSAPP, display_name: "543134@lid", address_book_name: null });
    expect(screen.queryByRole("button", { name: /Usar este nome/ })).not.toBeInTheDocument();
  });
});
