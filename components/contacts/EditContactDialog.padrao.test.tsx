/**
 * O ÚLTIMO PORTÃO DO FORMULÁRIO (#2730) — o submit não manda valor torto.
 *
 * O `CustomFieldsEditor` já avisa conforme se digita; este arquivo mede o que
 * acontece quando mesmo assim o botão "Salvar" é apertado: a MESMA régua do
 * servidor roda no `onSubmit`, a mensagem que aparece é a DO CAMPO
 * (`mensagem_padrao`) e o payload NÃO sai — o `mutateAsync` do PATCH não é
 * chamado. E o outro lado: valor dentro do padrão grava como sempre.
 */
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditContactDialog } from "@/components/contacts/EditContactDialog";
import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import type { Contact } from "@/lib/types/contacts";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ country: null }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/hooks/contacts/useUpdateContact", () => ({ useUpdateContact: () => useUpdate }));
const { mutateAsync, useUpdate } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  useUpdate: { mutateAsync: vi.fn(), isPending: false },
}));

const CAMPO_IDADES = {
  key: "idades",
  label: "Idades das crianças",
  type: "text" as const,
  padrao: "^\\d{1,2}(,\\d{1,2})*$",
  mensagem_padrao: "Use só números separados por vírgula, ex.: 2,9",
};

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

function pintar(fields: CustomFieldDef[] = [CAMPO_IDADES]) {
  function Janela() {
    const [aberto, setAberto] = useState(true);
    return (
      <EditContactDialog
        contact={contato}
        open={aberto}
        onOpenChange={setAberto}
        customFieldDefs={fields}
      />
    );
  }
  render(<Janela />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdate.mutateAsync = mutateAsync;
  mutateAsync.mockResolvedValue({});
});

describe("o submit recusa o valor fora do padrão", () => {
  it("apertar Salvar com valor torto não dispara o PATCH e mostra a frase DO CAMPO", async () => {
    const user = userEvent.setup();
    pintar();

    await user.type(screen.getByLabelText("Idades das crianças"), "dois");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(mutateAsync, "o payload torto saiu da tela mesmo com a régua").not.toHaveBeenCalled();
    const avisos = screen.getAllByRole("alert").map((n) => n.textContent);
    expect(avisos.join(" ")).toContain("Use só números separados por vírgula, ex.: 2,9");
    // A mensagem genérica não entra no lugar da do campo.
    expect(avisos.join(" ")).not.toContain("Valor fora do formato esperado para este campo.");
  });

  it("valor dentro do padrão segue e o PATCH acontece", async () => {
    const user = userEvent.setup();
    pintar();

    await user.type(screen.getByLabelText("Idades das crianças"), "2,9");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      custom_fields: { idades: "2,9" },
    });
  });

  it("campo SEM `padrao` grava o que a pessoa escreveu — o de sempre", async () => {
    const user = userEvent.setup();
    pintar([{ key: "observacao", label: "Observação", type: "text" }]);

    await user.type(screen.getByLabelText("Observação"), "dois e meio, com espaço");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      custom_fields: { observacao: "dois e meio, com espaço" },
    });
  });

  it("regex quebrada configura: recusa com a frase do PADRÃO e não derruba o diálogo", async () => {
    const user = userEvent.setup();
    expect(() =>
      pintar([{ key: "idades", label: "Idades", type: "text", padrao: "^\\d{1,2(" }]),
    ).not.toThrow();

    await user.type(screen.getByLabelText("Idades"), "2,9");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(mutateAsync).not.toHaveBeenCalled();
    const avisos = screen
      .getAllByRole("alert")
      .map((n) => n.textContent)
      .join(" ");
    expect(avisos).toContain("Padrão inválido configurado neste campo");
  });
});
