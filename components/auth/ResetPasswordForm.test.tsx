import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ResetPasswordForm } from "./ResetPasswordForm";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("@/app/actions/auth/updatePassword", () => ({
  updatePassword: vi.fn(),
}));

describe("ResetPasswordForm", () => {
  it("confirma a nova senha e permite visualizar cada campo separadamente", () => {
    render(<ResetPasswordForm />);

    const password = screen.getByLabelText("Nova senha");
    const confirmation = screen.getByLabelText("Confirmar nova senha");

    expect(password).toHaveAttribute("type", "password");
    expect(confirmation).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(confirmation).toHaveAttribute("autocomplete", "new-password");

    fireEvent.click(screen.getByRole("button", { name: "Mostrar nova senha" }));
    expect(password).toHaveAttribute("type", "text");
    expect(confirmation).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Ocultar nova senha" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Mostrar confirmação da senha" }));
    expect(confirmation).toHaveAttribute("type", "text");
    expect(
      screen.getByRole("button", { name: "Ocultar confirmação da senha" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("mostra a força da senha e os requisitos conforme a pessoa digita", () => {
    render(<ResetPasswordForm />);

    const password = screen.getByLabelText("Nova senha");
    const meter = screen.getByRole("meter", { name: "Força da senha" });

    expect(meter).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByTestId("password-strength-label")).toHaveTextContent("Muito fraca");

    fireEvent.change(password, { target: { value: "Senha123!" } });

    expect(meter).toHaveAttribute("aria-valuenow", "4");
    expect(meter).toHaveAttribute("aria-valuetext", "Forte");
    expect(screen.getByTestId("password-strength-label")).toHaveTextContent("Forte");
  });
});
