/**
 * #3363 — o DESTINO da gravação da resposta, na tela que edita a pergunta.
 *
 * Duas coisas precisam de prova no DOM, e nenhuma delas se vê no diff de código:
 *
 *  1. a opção EXISTE e começa no `contato` (o default de todo grafo que já tem);
 *  2. escolher o `negocio` escreve a chave no nó — e editar qualquer outro campo
 *     da pergunta não APAGA um destino já escolhido (o `commit` reconstrói o
 *     config inteiro a partir do formulário: sem a chave no candidate, a primeira
 *     edição de rótulo perderia o destino em silêncio).
 *
 * `contato` segue sendo a AUSÊNCIA da chave no JSON gravado — gravar o default
 * em cima do nó reescreveria o grafo de toda pergunta existente.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";

import type { ConfigOf } from "./shared";

import { CollectForm } from "./CollectForm";

beforeAll(() => {
  // Radix Select usa pointer capture e scrollIntoView; o jsdom não implementa
  // nenhum dos dois e o clique no gatilho morre antes de abrir a lista.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

/** `delay: null` mata a espera que o user-event insere entre cada evento. */
const usuario = () => userEvent.setup({ delay: null });

const TETO_MS = 30_000;

const PERGUNTA: ConfigOf<"collect"> = {
  key: "destino_viagem",
  label: "Destino da viagem",
  type: "text",
  required: true,
  permite_correcao: true,
};

const NOME_DO_SELETOR = "Onde a resposta é guardada";

describe("CollectForm — destino da gravação (#3363)", () => {
  it(
    "oferece ficha do contato e card do negócio, começando no contato",
    { timeout: TETO_MS },
    async () => {
      const user = usuario();
      render(<CollectForm config={PERGUNTA} onChange={() => {}} />);

      const gatilho = screen.getByRole("combobox", { name: NOME_DO_SELETOR });
      expect(gatilho.textContent).toContain("Ficha do contato");

      await user.click(gatilho);
      const itens = await screen.findAllByRole("option");
      expect(itens.map((i) => i.textContent)).toEqual([
        "Ficha do contato",
        "Card do negócio (cada negócio responde por si)",
      ]);
    },
  );

  it("escolher o negócio grava `destino: 'negocio'` no nó", { timeout: TETO_MS }, async () => {
    const gravados: Array<Record<string, unknown>> = [];
    const user = usuario();
    render(
      <CollectForm
        config={PERGUNTA}
        onChange={(c) => gravados.push(c as Record<string, unknown>)}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: NOME_DO_SELETOR }));
    await user.click(
      await screen.findByRole("option", { name: "Card do negócio (cada negócio responde por si)" }),
    );

    expect(gravados.at(-1)).toEqual({
      key: "destino_viagem",
      label: "Destino da viagem",
      type: "text",
      required: true,
      permite_correcao: true,
      destino: "negocio",
    });
  });

  it(
    "de volta ao contato, a chave some (contato = ausência no JSON)",
    { timeout: TETO_MS },
    async () => {
      const gravados: Array<Record<string, unknown>> = [];
      const user = usuario();
      render(
        <CollectForm
          config={{ ...PERGUNTA, destino: "negocio" }}
          onChange={(c) => gravados.push(c as Record<string, unknown>)}
        />,
      );

      await user.click(screen.getByRole("combobox", { name: NOME_DO_SELETOR }));
      await user.click(await screen.findByRole("option", { name: "Ficha do contato" }));

      expect(gravados.at(-1)).not.toHaveProperty("destino");
    },
  );

  it("editar a pergunta não apaga o destino já escolhido", async () => {
    const gravados: Array<Record<string, unknown>> = [];
    const user = usuario();
    render(
      <CollectForm
        config={{ ...PERGUNTA, destino: "negocio" }}
        onChange={(c) => gravados.push(c as Record<string, unknown>)}
      />,
    );

    await user.type(screen.getByLabelText("Pergunta (o que a IA deve perguntar)"), "!");
    expect(gravados.length).toBeGreaterThan(0);
    expect(gravados.at(-1)).toHaveProperty("destino", "negocio");
  });
});
