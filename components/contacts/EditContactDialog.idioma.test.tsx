import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import type { Contact } from "@/lib/types/contacts";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ country: null }),
}));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({
  useUpdateContact: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/tags/useDefinirCorDaEtiqueta", () => ({
  useDefinirCorDaEtiqueta: () => ({ definirCor: vi.fn(async () => true) }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [], isError: false }),
}));

const contato = {
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: "22222222-2222-4222-8222-222222222222",
  name: "Ana",
  email: null,
  phone_number: null,
  birthdate: null,
  tags: [],
  custom_fields: {},
} as unknown as Contact;

describe("diálogo Editar contato acompanha o idioma (#4904)", () => {
  it("em espanhol: traduz Nome para 'Nombre' e Email para 'Correo'", () => {
    render(
      <IdiomaProvider locale="es">
        <EditContactDialog contact={contato} open={true} onOpenChange={() => {}} />
      </IdiomaProvider>,
    );

    expect(screen.getByText("Nombre")).toBeInTheDocument();
    expect(screen.getByText("Correo")).toBeInTheDocument();
  });

  it("em português: mantém os rótulos 'Nome' e 'Email'", () => {
    render(
      <IdiomaProvider locale="pt-BR">
        <EditContactDialog contact={contato} open={true} onOpenChange={() => {}} />
      </IdiomaProvider>,
    );

    expect(screen.getByText("Nome")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
  });
});
