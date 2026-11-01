/**
 * O FORMULÁRIO MOSTRA A MENSAGEM DO CAMPO (#2730) — não uma genérica.
 *
 * A issue pede `padrao` + `mensagem_padrao` validados NO FORMULÁRIO. O que se
 * mede aqui é o que a pessoa VÊ quando digita fora do formato: a frase que o
 * dono do funil escreveu ("Use só números separados por vírgula, ex.: 2,9"),
 * no lugar do campo, como erro — e não "valor inválido".
 *
 * Também está medido o outro lado da moeda: campo SEM `padrao` continua livre
 * (nada de erro aparece), e regex quebrada configuração não derruba o
 * componente — a tela abre, recusa e diz que o padrão está inválido.
 */
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CustomFieldsEditor } from "@/components/contacts/CustomFieldsEditor";

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ country: null }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const IDADES = {
  key: "idades",
  label: "Idades das crianças",
  type: "text" as const,
  padrao: "^\\d{1,2}(,\\d{1,2})*$",
  mensagem_padrao: "Use só números separados por vírgula, ex.: 2,9",
};

function pintar(fields: Parameters<typeof CustomFieldsEditor>[0]["fields"]) {
  /**
   * O editor é CONTROLADO: ele devolve o novo valor pelo `onChange` e passa a
   * ver o que o pai re-renderizou. Sem esta janela, digitar não mudaria nada em
   * `value` e o teste mediria um componente congelado — não o formulário.
   */
  function Janela() {
    const [valor, setValor] = useState<Record<string, unknown>>({});
    return <CustomFieldsEditor fields={fields} value={valor} onChange={setValor} mode="contact" />;
  }
  render(<Janela />);
}

describe("a mensagem do campo vira erro no formulário", () => {
  it("digitar fora do formato mostra a `mensagem_padrao` DO CAMPO, com role de erro", async () => {
    const user = userEvent.setup();
    pintar([IDADES]);

    // Em branco: nada a reclamar — o campo é opcional, obrigatoriedade é outra régua.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Idades das crianças"), "dois");

    const erro = screen.getByRole("alert");
    expect(erro).toHaveTextContent("Use só números separados por vírgula, ex.: 2,9");
    // NUNCA a mensagem genérica quando o campo tem a sua.
    expect(erro).not.toHaveTextContent("Valor fora do formato esperado para este campo.");
  });

  it("o valor que casa o padrão limpa o erro", async () => {
    const user = userEvent.setup();
    pintar([IDADES]);

    await user.type(screen.getByLabelText("Idades das crianças"), "dois");
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Idades das crianças"));
    await user.type(screen.getByLabelText("Idades das crianças"), "2,9");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sem `mensagem_padrao` configurada, a genérica aparece (e é uma frase de verdade)", async () => {
    const user = userEvent.setup();
    pintar([{ key: "localizador", label: "Localizador", type: "text", padrao: "^[A-Z0-9]{6}$" }]);

    await user.type(screen.getByLabelText("Localizador"), "abc");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Valor fora do formato esperado para este campo.",
    );
  });
});

describe("campo sem padrão continua livre — byte a byte o de sempre", () => {
  it("texto qualquer, num campo sem `padrao`, não gera erro nenhum", async () => {
    const user = userEvent.setup();
    pintar([{ key: "observacao", label: "Observação", type: "text" }]);

    await user.type(screen.getByLabelText("Observação"), "livre, com números 123 e ç cã");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("`mensagem_padrao` sozinha (sem `padrao`) não restringe nada", async () => {
    const user = userEvent.setup();
    pintar([{ key: "obs", label: "Observação", type: "text", mensagem_padrao: "só números" }]);

    await user.type(screen.getByLabelText("Observação"), "texto qualquer");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("regex inválida configurada — a tela não derruba e não aprova tudo", () => {
  it("abre, recusa e diz que o PADRÃO está inválido (não que o valor está errado)", async () => {
    const user = userEvent.setup();
    expect(() =>
      pintar([{ key: "idades", label: "Idades", type: "text", padrao: "^\\d{1,2(" }]),
    ).not.toThrow();

    await user.type(screen.getByLabelText("Idades"), "2,9");

    const erro = screen.getByRole("alert");
    expect(erro).toHaveTextContent("Padrão inválido configurado neste campo");
    expect(erro).not.toHaveTextContent("Use só números");
  });
});
