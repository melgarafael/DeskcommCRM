import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/team/acceptInvite", () => ({ acceptInviteAction: vi.fn() }));

import { acceptInviteAction } from "@/app/actions/team/acceptInvite";

import { AcceptInviteForm } from "./AcceptInviteForm";

/**
 * O limite de pessoas do plano não pode aparecer como "seu convite venceu":
 * quem lê isso pede um link novo, e o link novo falha pelo mesmo motivo.
 */
const ROTULOS = {
  token: "tok",
  label: "Aceitar convite",
  pendingLabel: "Confirmando…",
  failureLabel: "FALHA GENERICA",
  planLimitLabel: "LIMITE DO PLANO",
};

describe("AcceptInviteForm", () => {
  it.each([
    ["limite_do_plano", "LIMITE DO PLANO"],
    ["invalid_or_expired", "FALHA GENERICA"],
  ] as const)("recusa %s mostra a frase certa", async (error, esperado) => {
    vi.mocked(acceptInviteAction).mockResolvedValue({ ok: false, error });
    render(<AcceptInviteForm {...ROTULOS} />);
    fireEvent.submit(screen.getByRole("button", { name: "Aceitar convite" }).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe(esperado);
  });
});
