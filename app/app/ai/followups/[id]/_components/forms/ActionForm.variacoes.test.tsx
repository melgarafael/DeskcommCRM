/**
 * #4429 — a TELA do passo de mensagem com mais de uma redação.
 *
 * A decisão de qual redação sai é do motor (`lib/followup/engine.ts`): aqui só
 * se prende que o operador consegue CADASTRAR as outras redações, que elas
 * aparecem quando o passo já as tem, e que uma caixa vazia recém-aberta não
 * vira configuração inválida (o que travaria o gravar a cada clique).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConfigOf } from "./shared";
import { ActionForm } from "./ActionForm";

vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useGruposDeRespostas: () => ({ data: [] }),
  useMessageTemplates: () => ({ data: [], isLoading: false, isError: false, isSuccess: true }),
}));
vi.mock("@/hooks/followup/useModelosAprovadosDoFluxo", () => ({
  useModelosAprovadosDoFluxo: () => ({ data: [], isLoading: false, isError: false, isSuccess: true }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

const CORPO = "Oi {{primeiro_nome}}, tudo bem?";

function renderizar(config: ConfigOf<"action">, onChange = vi.fn()) {
  render(<ActionForm config={config} onChange={onChange} />);
  return onChange;
}

describe("ActionForm — redações do passo de mensagem (#4429)", () => {
  it("mostra as redações que o passo já tem, cada uma no seu campo", () => {
    renderizar({ mode: "text", body: CORPO, variacoes: ["Primeira alternativa", "Segunda alternativa"] });

    expect((screen.getByLabelText("Redação 2") as HTMLTextAreaElement).value).toBe("Primeira alternativa");
    expect((screen.getByLabelText("Redação 3") as HTMLTextAreaElement).value).toBe("Segunda alternativa");
  });

  it("passo de texto único continua sem nenhuma caixa de redação", () => {
    renderizar({ mode: "text", body: CORPO });

    expect(screen.queryByLabelText("Redação 2")).toBeNull();
    expect((screen.getByLabelText("Texto enviado ao contato") as HTMLTextAreaElement).value).toBe(CORPO);
  });

  it("⭐ o botão abre a caixa e o texto digitado vira `variacoes` no config", () => {
    const onChange = renderizar({ mode: "text", body: CORPO });

    fireEvent.click(screen.getByRole("button", { name: "Redação" }));
    const nova = screen.getByLabelText("Redação 2") as HTMLTextAreaElement;
    expect(nova.value).toBe("");

    fireEvent.change(nova, { target: { value: "  Outra forma de dizer  " } });

    expect(onChange).toHaveBeenLastCalledWith({
      mode: "text",
      body: CORPO,
      variacoes: ["Outra forma de dizer"],
    });
  });

  it("caixa vazia não entra no config — e o texto principal continua gravando", () => {
    const onChange = renderizar({ mode: "text", body: CORPO });

    fireEvent.click(screen.getByRole("button", { name: "Redação" }));
    fireEvent.change(screen.getByLabelText("Texto enviado ao contato"), { target: { value: "Oi, tudo bem?" } });

    expect(onChange).toHaveBeenLastCalledWith({ mode: "text", body: "Oi, tudo bem?" });
  });

  it("remover a redação tira ela do config", () => {
    const onChange = renderizar({ mode: "text", body: CORPO, variacoes: ["Fica", "Sai"] });

    fireEvent.click(screen.getAllByRole("button", { name: "Remover redação" })[1]!);

    expect(onChange).toHaveBeenLastCalledWith({ mode: "text", body: CORPO, variacoes: ["Fica"] });
  });

  it("no teto de redações o botão desabilita", () => {
    renderizar({
      mode: "text",
      body: CORPO,
      variacoes: ["1", "2", "3", "4", "5"],
    });

    expect((screen.getByRole("button", { name: "Redação" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
