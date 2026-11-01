/**
 * A escolha do que aparece com o celular bloqueado: quem não é admin só lê;
 * o admin troca, e um erro devolve a tela ao valor que vale.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { definir, toastFalso } = vi.hoisted(() => ({
  definir: vi.fn(),
  toastFalso: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/actions/settings/definirConteudoNaTelaBloqueada", () => ({
  definirConteudoNaTelaBloqueada: definir,
}));
vi.mock("sonner", () => ({ toast: toastFalso }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

import { EscolhaDaTelaBloqueada } from "@/app/app/settings/notifications/_tela-bloqueada-escolha";

const radio = (v: string) => screen.getByTestId(`tela-bloqueada-${v}`) as HTMLInputElement;

beforeEach(() => vi.clearAllMocks());

describe("EscolhaDaTelaBloqueada", () => {
  it("quem não é admin vê o valor em vigor, sem poder mudar", () => {
    render(<EscolhaDaTelaBloqueada valorInicial="nome" podeEditar={false} />);
    expect(radio("nome").checked).toBe(true);
    expect(screen.getByRole("group")).toBeDisabled();
    expect(screen.getByText("Quem decide é um administrador.")).toBeTruthy();
  });

  it("o admin troca e a tela confirma", async () => {
    definir.mockResolvedValue({ ok: true, valor: "oculto", mudou: true });
    render(<EscolhaDaTelaBloqueada valorInicial="nome" podeEditar />);
    fireEvent.click(radio("oculto"));
    await waitFor(() => expect(toastFalso.success).toHaveBeenCalledWith("Salvo"));
    expect(definir).toHaveBeenCalledWith("oculto");
    expect(radio("oculto").checked).toBe(true);
  });

  it("erro na gravação volta ao valor anterior e diz o motivo", async () => {
    definir.mockResolvedValue({ ok: false, erro: "mfa" });
    render(<EscolhaDaTelaBloqueada valorInicial="nome" podeEditar />);
    fireEvent.click(radio("nome_e_previa"));
    await waitFor(() =>
      expect(toastFalso.error).toHaveBeenCalledWith("Confirme a verificação em duas etapas nesta sessão."),
    );
    expect(radio("nome").checked).toBe(true);
  });

  // A opção vale para toda notificação fora do app, não só para o celular.
  it("diz que vale para o celular e para o computador", () => {
    render(<EscolhaDaTelaBloqueada valorInicial="nome" podeEditar={false} />);
    expect(screen.getByRole("heading", { name: "O que os avisos mostram fora do app" })).toBeTruthy();
    expect(
      screen.getByText(
        "Vale para o celular bloqueado e para as notificações do computador, para toda a empresa. Só administradores podem mudar.",
      ),
    ).toBeTruthy();
  });
});
