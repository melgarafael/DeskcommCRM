/**
 * A JANELA DE CAMPOS OBRIGATÓRIOS MOSTRA A LISTA DO FUNIL, NÃO TEXTO LIVRE
 * (issue #5181).
 *
 * Medido na main: `validaCamposExigidos` (`lib/leads/campos-exigidos.ts`)
 * empurra o `won_reason` faltante como `{ chave, rotulo }` — sem `opcoes`,
 * porque a lista de motivos não é assunto da régua —, e o diálogo, que só
 * renderiza seletor quando o campo traz `opcoes`, caía no `input` de texto. A
 * pessoa digitava, confirmava, e o servidor recusava depois com
 * `won_reason_invalid` (o vocabulário é dele: `settings.won_reasons`).
 *
 * Este teste NÃO mexe na régua do servidor: ele prova que, com a lista do funil
 * em mãos, a janela renderiza o MESMO `Select` dos campos personalizados — e
 * que, sem lista, o input de texto continua sendo o caminho (texto livre é o
 * contrato do servidor quando o funil não cadastrou vocabulário).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

// jsdom não implementa captura de ponteiro, e o gatilho do `Select` do Radix lê
// `hasPointerCapture` antes de abrir (mesmo remédio dos vizinhos de agenda).
beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useMoedaDaOrgAtiva: () => null }));

import { CamposObrigatoriosDialog } from "@/components/kanban/CamposObrigatoriosDialog";

/** A recusa como o servidor a manda: o motivo de ganho só com chave e rótulo. */
const RECUSA = {
  args: { leadId: "l-1" } as never,
  faltando: [{ chave: "won_reason", rotulo: "Motivo do ganho" }],
};

function montar(wonReasons?: string[]) {
  const confirmados: Array<{ customFields: Record<string, unknown>; wonReason?: string }> = [];
  render(
    <CamposObrigatoriosDialog
      open
      onOpenChange={() => {}}
      recusa={RECUSA}
      wonReasons={wonReasons}
      onConfirmar={(v) => confirmados.push(v)}
    />,
  );
  // A janela é renderizada em PORTAL, então quem a contém é o documento — não
  // o nó do `render`. Procurar dentro do nó devolveria `null` para qualquer um
  // dos dois desenhos e o teste passaria com o defeito dentro.
  return { confirmados };
}

describe("#5181 — a janela de campos obrigatórios com o motivo do ganho", () => {
  it("funil COM lista: o campo vira seletor (combobox) e a escolha sai como wonReason", async () => {
    const user = userEvent.setup();
    const { confirmados } = montar(["Renovação", "Expansão de contrato"]);

    // O seletor dos outros `select`, e nenhum input de texto no lugar dele.
    const seletor = screen.getByRole("combobox", { name: "Motivo do ganho" });
    expect(seletor).toBeTruthy();
    expect(document.querySelector('input[type="text"]')).toBeNull();

    await user.click(seletor);
    await user.click(await screen.findByRole("option", { name: "Expansão de contrato" }));
    await user.click(screen.getByRole("button", { name: "Mover agora" }));

    expect(confirmados).toEqual([{ customFields: {}, wonReason: "Expansão de contrato" }]);
  });

  it("funil SEM lista: continua texto livre, como o servidor aceita", () => {
    montar(undefined);

    expect(screen.getByRole("textbox", { name: "Motivo do ganho" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.querySelector('input[type="text"]')).toBeTruthy();
  });

  it("lista VAZIA é texto livre — o mesmo que não ter lista", () => {
    montar([]);

    expect(screen.getByRole("textbox", { name: "Motivo do ganho" })).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
