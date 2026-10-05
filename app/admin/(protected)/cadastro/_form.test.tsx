/**
 * Admin só-leitura (ou com a verificação em duas etapas pendente) que mexe no
 * interruptor lê o MOTIVO da recusa, não "tente de novo" — tentar de novo não
 * resolve nada, e a mensagem genérica o mandaria insistir.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { updateSignupMode } = vi.hoisted(() => ({ updateSignupMode: vi.fn() }));
vi.mock("@/app/actions/settings/updateSignupMode", () => ({ updateSignupMode }));

import { FormularioDeCadastro } from "./_form";

describe("FormularioDeCadastro — recusa de escrita de admin", () => {
  it.each([
    ["forbidden_scope", "Seu acesso à administração da plataforma é somente leitura."],
    ["mfa_required", "Confirme a verificação em duas etapas nesta sessão."],
  ])("%s → mostra o motivo e desfaz o interruptor", async (codigo, frase) => {
    updateSignupMode.mockResolvedValue({ ok: false, error: codigo });
    render(<FormularioDeCadastro modoInicial="aberto" />);
    const chave = screen.getByRole("switch", { name: "Cadastro apenas por convite" });
    fireEvent.click(chave);
    expect(await screen.findByText(frase)).toBeInTheDocument();
    await waitFor(() => expect(chave).toHaveAttribute("aria-checked", "false"));
  });

  it("falha comum segue com a mensagem genérica", async () => {
    updateSignupMode.mockResolvedValue({ ok: false, error: "write_failed" });
    render(<FormularioDeCadastro modoInicial="aberto" />);
    fireEvent.click(screen.getByRole("switch", { name: "Cadastro apenas por convite" }));
    expect(await screen.findByText("Não deu para salvar. Tente de novo em instantes.")).toBeInTheDocument();
  });
});
