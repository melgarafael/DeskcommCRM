/**
 * O DOCUMENTO NA EDIÇÃO DO CONTATO.
 *
 * O PATCH já aceitava `cpf`, mas o diálogo não tinha o campo: um CPF digitado
 * errado no cadastro não tinha como ser corrigido pela tela. Este arquivo mede
 * as três regras do campo:
 *
 *   1. vazio NÃO manda `cpf` — o número gravado não vem para a tela, então o
 *      campo abre vazio, e vazio quer dizer "não mexer";
 *   2. preenchido e válido manda `cpf` no PATCH;
 *   3. inválido avisa no campo e não deixa salvar — a régua do cadastro (#3496).
 *
 * CPFs fictícios, gerados pelo dígito verificador; nenhum de pessoa real.
 */
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import type { Contact } from "@/lib/types/contacts";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ country: null }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({ useUpdateContact: () => useUpdate }));
vi.mock("@/hooks/tags/useDefinirCorDaEtiqueta", () => ({
  useDefinirCorDaEtiqueta: () => ({ definirCor: vi.fn(async () => true) }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [], isError: false }),
}));
const { mutateAsync, useUpdate } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  useUpdate: { mutateAsync: vi.fn(), isPending: false },
}));

const CPF_VALIDO = "529.982.247-25";

function contato(cpfAvailable: boolean): Contact {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organization_id: "22222222-2222-4222-8222-222222222222",
    name: "Ana",
    email: null,
    phone_number: null,
    birthdate: null,
    cpf_available: cpfAvailable,
    tags: [],
    custom_fields: {},
  } as unknown as Contact;
}

function pintar(alvo: Contact) {
  function Janela() {
    const [aberto, setAberto] = useState(true);
    return <EditContactDialog contact={alvo} open={aberto} onOpenChange={setAberto} />;
  }
  render(<Janela />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdate.mutateAsync = mutateAsync;
  mutateAsync.mockResolvedValue({});
});

describe("o campo de CPF na edição", () => {
  it("existe, rotulado pelo documento do país, e abre vazio", () => {
    pintar(contato(true));
    const campo = screen.getByLabelText("CPF");
    expect(campo).toHaveValue("");
  });

  it("diz quando já há CPF cadastrado — o número não vem para a tela", () => {
    pintar(contato(true));
    expect(screen.getByText("Já cadastrado. Preencha só para trocar.")).toBeInTheDocument();
  });

  it("vazio não manda `cpf` no PATCH: salvar outra coisa não mexe no documento", async () => {
    const user = userEvent.setup();
    pintar(contato(true));

    await user.clear(screen.getByLabelText("Nome"));
    await user.type(screen.getByLabelText("Nome"), "Ana Maria");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty("cpf");
  });

  it("preenchido e válido sai no PATCH", async () => {
    const user = userEvent.setup();
    pintar(contato(false));

    await user.type(screen.getByLabelText("CPF"), CPF_VALIDO);
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({ cpf: CPF_VALIDO });
  });

  it("inválido avisa no campo ao sair dele e não deixa salvar", async () => {
    const user = userEvent.setup();
    pintar(contato(false));

    await user.type(screen.getByLabelText("CPF"), "111.111.111-12");
    await user.tab();

    expect(await screen.findByRole("alert")).toHaveTextContent("CPF inválido");
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
