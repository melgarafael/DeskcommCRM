/**
 * O endereço da pessoa física (#3494) pela ficha — apagar também é escrever.
 *
 * A prova pela tela do #3670 mediu: apagar só o Complemento e salvar deixava
 * "apto 42" no banco, porque o campo vazio não ia no PATCH. Aqui se mede o
 * payload: o campo esvaziado vai como `null`, o preenchido vai com o valor, e
 * o campo que já estava vazio não aparece. E a UF longa é recusada com uma
 * frase em português, sem disparar o PATCH.
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
/* A ficha pergunta ao vocabulário curado o que o texto digitado casaria (#3144),
   e essa leitura é react-query. Este fixture monta o diálogo sem provider e o
   assunto aqui é o endereço, então a leitura é dublada como em `padrao`. */
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({
  useContactTagVocabulary: () => ({ data: [], isError: false }),
}));
const { mutateAsync, useUpdate } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  useUpdate: { mutateAsync: vi.fn(), isPending: false },
}));

const comEndereco = {
  id: "33333333-3333-4333-8333-333333333333",
  organization_id: "22222222-2222-4222-8222-222222222222",
  name: "Ana",
  email: null,
  phone_number: null,
  birthdate: null,
  tags: [],
  custom_fields: {},
  zip_code: "80000-000",
  street: "Rua XV de Novembro",
  number: "120",
  complement: "apto 42",
  district: "Centro",
  city: "Curitiba",
  state: "PR",
} as unknown as Contact;

function pintar(alvo: Contact) {
  function Janela() {
    const [aberto, setAberto] = useState(true);
    return (
      <EditContactDialog contact={alvo} open={aberto} onOpenChange={setAberto} customFieldDefs={[]} />
    );
  }
  render(<Janela />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdate.mutateAsync = mutateAsync;
  mutateAsync.mockResolvedValue({});
});

describe("endereço pela ficha", () => {
  it("apagar só o Complemento manda complement: null e mantém o resto", async () => {
    const user = userEvent.setup();
    pintar(comEndereco);

    await user.clear(screen.getByLabelText("Complemento"));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const payload = mutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.complement).toBeNull();
    expect(payload).toMatchObject({ street: "Rua XV de Novembro", city: "Curitiba", state: "PR" });
  });

  it("campo que já estava vazio não entra no payload", async () => {
    const user = userEvent.setup();
    pintar({ ...comEndereco, complement: null } as unknown as Contact);

    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0]?.[0]).not.toHaveProperty("complement");
  });

  it("UF com três letras é recusada em português, sem PATCH", async () => {
    const user = userEvent.setup();
    pintar(comEndereco);

    await user.clear(screen.getByLabelText("UF"));
    await user.type(screen.getByLabelText("UF"), "PAR");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(mutateAsync).not.toHaveBeenCalled();
    const avisos = screen.getAllByRole("alert").map((n) => n.textContent).join(" ");
    expect(avisos).toContain("UF com 2 letras (ex.: SP)");
  });
});
