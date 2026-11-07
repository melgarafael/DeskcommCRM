/**
 * A AÇÃO `remove_tag` ("Tirar tag") NO EDITOR DE AUTOMAÇÕES.
 *
 * O schema aceitar e o motor executar não bastam: sem rótulo, caixa e
 * formulário a ação não existe no produto. Monta o formulário REAL
 * (`ActionConfigForm`), controlado como no editor, e confere rótulo, paleta,
 * espanhol, padrão e que escrever as tags preserva o destino escolhido.
 */
import * as React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
import { ACTION_LABELS } from "@/app/app/webhooks/_components/labels";
import { ACOES_DA_PALETA, VISUAL_DA_ACAO } from "@/app/app/webhooks/automacoes/[id]/_components/visual";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { actionSchema } from "@/lib/schemas/webhooks";

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

describe("editor de automações — Tirar tag", () => {
  it("rótulo, paleta e espanhol existem", () => {
    expect(ACTION_LABELS.remove_tag).toBe("Tirar tag");
    expect(ACOES_DA_PALETA).toContain("remove_tag");
    expect(VISUAL_DA_ACAO.remove_tag.paleta).toBe("Tirar tag");
    for (const frase of [
      "Tirar tag",
      "Tags para tirar (separadas por vírgula)",
      "De onde tirar",
      "Do card",
      "Do contato do lead",
      "Sem contato vinculado, nenhuma etiqueta é tirada.",
    ]) {
      expect(DICIONARIO[frase]?.es, frase).toBeTruthy();
    }
  });

  it("o padrão é o mesmo da add_tag: sem a chave destino (card)", () => {
    expect(defaultActionConfig("remove_tag")).toEqual({ type: "remove_tag", config: { tags: [] } });
  });

  it("o schema aceita o que o editor grava", () => {
    expect(actionSchema.safeParse({ type: "remove_tag", config: { tags: ["vip"] } }).success).toBe(true);
    expect(
      actionSchema.safeParse({ type: "remove_tag", config: { tags: ["vip"], destino: "contato" } }).success,
    ).toBe(true);
    expect(actionSchema.safeParse({ type: "remove_tag", config: { tags: [] } }).success).toBe(false);
  });

  it("escolher 'Do contato do lead' e depois escrever as tags preserva o destino", async () => {
    const { user, onChange } = montar(defaultActionConfig("remove_tag"));

    expect(screen.getByText("De onde tirar")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Do contato do lead" }));
    expect(screen.getByText("Sem contato vinculado, nenhuma etiqueta é tirada.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Tags para tirar (separadas por vírgula)"), "vip, quente");
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      type: "remove_tag",
      config: { tags: ["vip", "quente"], destino: "contato" },
    });
  });
});
