/**
 * O DESTINO DA `add_tag` FICA À VISTA NO EDITOR DE AUTOMAÇÕES (#2498).
 *
 * ─── Por que um teste de tela para uma chave de API ────────────────────────
 *
 * A chave `destino` só existe de verdade quando quem usa consegue escolhê-la.
 * O schema aceitar e a ação ler não bastam: se o editor não expuser o campo, a
 * feature existe no banco e não existe no produto — e o caso mais provável de
 * regressão é justamente alguém "limpar" o formulário e escrever `onChange({
 * tags })` de novo, apagando o destino que o operador acabou de marcar.
 *
 * Aqui se monta o formulário REAL (`ActionConfigForm`) com a ação `add_tag`:
 *
 *   1. o rótulo e as DUAS opções existem (padrão e contato);
 *   2. escolher "Contato do lead" grava `destino: "contato"` no config;
 *   3. o padrão continua sendo o card — quem nunca mexeu não ganha chave;
 *   4. escrever nas tags DEPOIS de escolher o destino preserva a escolha;
 *   5. o aviso "sem contato, não aplica" só aparece com o destino contato —
 *      com o card ele é falso (o card recebe a etiqueta mesmo sem contato).
 */
import * as React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom não implementa captura de ponteiro; o gatilho do Select do Radix lê
// `hasPointerCapture` antes de abrir (mesmo remédio do editor de regras).
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
}));

import {
  ActionConfigForm,
  defaultActionConfig,
  type ActionItem,
} from "@/app/app/webhooks/_components/ActionConfigForm";

/** O formulário CONTROLADO — como o editor real, que re-renderiza a cada troca. */
function montar(inicial: ActionItem) {
  const onChange = vi.fn();
  function Editor() {
    const [acao, setAcao] = React.useState(inicial);
    return (
      <ActionConfigForm
        action={acao}
        onChange={(next) => {
          onChange(next);
          setAcao(next);
        }}
      />
    );
  }
  const user = userEvent.setup({ delay: null });
  render(<Editor />);
  return { user, onChange };
}

/** Abre o seletor de destino e devolve as opções. */
async function abrirDestino(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox"));
  return {
    card: screen.getByRole("option", { name: "Card (comportamento atual)" }),
    contato: screen.getByRole("option", { name: "Contato do lead" }),
  };
}

describe("o editor de automações expõe o destino da etiqueta", () => {
  it("o rótulo e as DUAS opções estão na tela", async () => {
    const { user } = montar(defaultActionConfig("add_tag"));

    expect(screen.getByText("Destino da etiqueta")).toBeInTheDocument();
    const opcoes = await abrirDestino(user);
    expect(opcoes.card).toBeInTheDocument();
    expect(opcoes.contato).toBeInTheDocument();
  });

  it("escolher 'Contato do lead' grava destino: 'contato' no config", async () => {
    const { user, onChange } = montar({ type: "add_tag", config: { tags: ["origem"] } });

    const opcoes = await abrirDestino(user);
    await user.click(opcoes.contato);

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      type: "add_tag",
      config: { tags: ["origem"], destino: "contato" },
    });
  });

  it("quem nunca mexeu continua SEM a chave — o padrão é implícito", () => {
    const padrao = defaultActionConfig("add_tag");
    expect(padrao.config).toEqual({ tags: [] });
    expect("destino" in padrao.config).toBe(false);
  });

  it("o padrão visível é o CARD (a opção marcada a primeira vez)", async () => {
    const { user } = montar({ type: "add_tag", config: { tags: ["origem"] } });

    const opcoes = await abrirDestino(user);
    expect(opcoes.card).toHaveAttribute("aria-selected", "true");
    expect(opcoes.contato).toHaveAttribute("aria-selected", "false");
  });

  it("escrever nas tags DEPOIS de escolher o destino preserva a escolha", async () => {
    const { user, onChange } = montar({ type: "add_tag", config: { tags: [] } });

    const opcoes = await abrirDestino(user);
    await user.click(opcoes.contato);
    await user.type(screen.getByRole("textbox"), "origem, quente");

    const ultimo = onChange.mock.calls.at(-1)?.[0] as {
      config: { tags: string[]; destino?: string };
    };
    // O defeito que este caso pega: `onChange({ tags })` no campo de texto
    // descarta o destino que o Select acabou de gravar — a tela mostra
    // "Contato do lead" e o payload salva card.
    expect(ultimo.config.destino).toBe("contato");
    expect(ultimo.config.tags).toEqual(["origem", "quente"]);
  });

  it("o aviso de 'sem contato' só aparece com o destino contato", async () => {
    const aviso = "Sem contato vinculado, a etiqueta não é aplicada.";
    const { user } = montar(defaultActionConfig("add_tag"));

    // Padrão (sem a chave) e card: o card recebe a etiqueta mesmo sem
    // contato, então a frase seria falsa aqui.
    expect(screen.queryByText(aviso)).toBeNull();

    const opcoes = await abrirDestino(user);
    await user.click(opcoes.contato);
    expect(screen.getByText(aviso)).toBeInTheDocument();

    const devolta = await abrirDestino(user);
    await user.click(devolta.card);
    expect(screen.queryByText(aviso)).toBeNull();
  });
});
