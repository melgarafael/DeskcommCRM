/**
 * O CEP preenche o endereço da ficha (#3494, fatia 2).
 *
 * Antes desta fatia a ficha tinha os sete campos e NENHUM autocompletar: quem
 * recebia o CEP por telefone digitava logradouro, bairro, cidade e UF à mão —
 * e errava o bairro, que é o que o frete lê. Aqui se mede o preenchimento e,
 * principalmente, o que ele NÃO pode fazer:
 *
 *   • não sobrescreve número nem complemento (são do imóvel, não do CEP);
 *   • CEP de 7 dígitos não consulta, avisa no campo e AINDA ASSIM salva;
 *   • CEP inexistente avisa e não impede salvar — erro de preenchimento não é
 *     erro de cadastro.
 */
import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import type { Contact } from "@/lib/types/contacts";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ country: orgPais.valor }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({ useUpdateContact: () => useUpdate }));
vi.mock("@/hooks/tags/useDefinirCorDaEtiqueta", () => ({
  useDefinirCorDaEtiqueta: () => ({ definirCor: vi.fn(async () => true) }),
}));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [], isError: false }),
}));

const { mutateAsync, orgPais, useUpdate } = vi.hoisted(() => ({
  orgPais: { valor: null as string | null },
  mutateAsync: vi.fn(),
  useUpdate: { mutateAsync: vi.fn(), isPending: false },
}));

/** Contato com número e complemento digitados e o resto do endereço vazio. */
const SEM_ENDERECO = {
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: "22222222-2222-4222-8222-222222222222",
  name: "Ana",
  email: null,
  phone_number: null,
  birthdate: null,
  tags: [],
  custom_fields: {},
  zip_code: null,
  street: null,
  number: "120",
  complement: "apto 42",
  district: null,
  city: null,
  state: null,
} as unknown as Contact;

const CEP_OK = {
  cep: "80000-000",
  street: "Rua XV de Novembro",
  district: "Centro",
  city: "Curitiba",
  state: "PR",
};

function pintar(alvo: Contact) {
  function Janela() {
    const [aberto, setAberto] = useState(true);
    return (
      <EditContactDialog
        contact={alvo}
        open={aberto}
        onOpenChange={setAberto}
        customFieldDefs={[]}
      />
    );
  }
  render(<Janela />);
}

function responderCep(status: number, corpo: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(corpo), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  orgPais.valor = null;
  useUpdate.mutateAsync = mutateAsync;
  mutateAsync.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CEP preenchendo a ficha", () => {
  it("preenche logradouro, bairro, cidade e UF sem tocar em número e complemento", async () => {
    responderCep(200, { data: CEP_OK });
    const user = userEvent.setup();
    pintar(SEM_ENDERECO);

    await user.type(screen.getByLabelText("CEP"), "80000-000");
    await user.tab();

    await waitFor(() =>
      expect(screen.getByLabelText("Logradouro")).toHaveValue("Rua XV de Novembro"),
    );
    expect(screen.getByLabelText("Bairro")).toHaveValue("Centro");
    expect(screen.getByLabelText("Cidade")).toHaveValue("Curitiba");
    expect(screen.getByLabelText("UF")).toHaveValue("PR");
    // O que o CEP NÃO sabe continua como estava.
    expect(screen.getByLabelText("Número")).toHaveValue("120");
    expect(screen.getByLabelText("Complemento")).toHaveValue("apto 42");
  });

  it("o endereço preenchido é o que o PATCH leva", async () => {
    responderCep(200, { data: CEP_OK });
    const user = userEvent.setup();
    pintar(SEM_ENDERECO);

    await user.type(screen.getByLabelText("CEP"), "80000-000");
    await user.tab();
    await waitFor(() => expect(screen.getByLabelText("Cidade")).toHaveValue("Curitiba"));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      zip_code: "80000-000",
      street: "Rua XV de Novembro",
      district: "Centro",
      city: "Curitiba",
      state: "PR",
      number: "120",
      complement: "apto 42",
    });
  });

  it("CEP de 7 dígitos não consulta, avisa no campo — e salvar continua possível", async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: CEP_OK }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    pintar(SEM_ENDERECO);

    await user.type(screen.getByLabelText("CEP"), "8000000");
    await user.tab();

    expect(await screen.findByText("CEP deve ter 8 dígitos.")).toBeInTheDocument();
    expect(fetchStub).not.toHaveBeenCalled();
    // O campo é do formulário, não da consulta: o que foi digitado permanece.
    expect(screen.getByLabelText("CEP")).toHaveValue("8000000");

    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({ zip_code: "8000000" });
  });

  it("CEP inexistente avisa e NÃO impede salvar", async () => {
    responderCep(404, { error: { code: "cep_nao_encontrado", message: "CEP não encontrado." } });
    const user = userEvent.setup();
    pintar(SEM_ENDERECO);

    await user.type(screen.getByLabelText("CEP"), "99999-999");
    await user.tab();

    expect(await screen.findByText("CEP não encontrado.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  });

  it("passar pelo CEP sem mudar nada não consulta nem reescreve o que foi digitado", async () => {
    responderCep(200, { data: CEP_OK });
    const user = userEvent.setup();
    pintar({
      ...SEM_ENDERECO,
      zip_code: "80000-000",
      street: "Rua XV de Novembro, bloco B",
      district: "Centro Histórico",
      city: "Curitiba",
      state: "PR",
    });

    await user.click(screen.getByLabelText("CEP"));
    await user.tab();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Logradouro")).toHaveValue("Rua XV de Novembro, bloco B");
    expect(screen.getByLabelText("Bairro")).toHaveValue("Centro Histórico");
  });

  it("organização fora do Brasil: o código postal não consulta nem ganha aviso de CEP", async () => {
    orgPais.valor = "PT";
    responderCep(200, { data: CEP_OK });
    const user = userEvent.setup();
    pintar(SEM_ENDERECO);

    await user.type(screen.getByLabelText("CEP"), "1000-001");
    await user.tab();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(screen.queryByText("CEP deve ter 8 dígitos.")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
