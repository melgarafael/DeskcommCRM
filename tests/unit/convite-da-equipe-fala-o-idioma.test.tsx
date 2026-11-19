import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InviteForm } from "@/app/app/team/invite/_components/InviteForm";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

vi.mock("@/hooks/team/useInviteMembers", () => ({
  useInviteMembers: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

afterEach(() => {
  cleanup();
});

describe("formulário de convite da equipe acompanha o idioma (#4905)", () => {
  it("em espanhol: traduz 'E-mails' para 'Correos' e 'Papel' para 'Rol'", () => {
    render(
      <IdiomaProvider locale="es">
        <InviteForm />
      </IdiomaProvider>,
    );

    expect(screen.getByText("Correos")).toBeInTheDocument();
    expect(screen.getByText("Rol")).toBeInTheDocument();
  });

  it("em português: mantém os rótulos 'E-mails' e 'Papel'", () => {
    render(
      <IdiomaProvider locale="pt-BR">
        <InviteForm />
      </IdiomaProvider>,
    );

    expect(screen.getByText("E-mails")).toBeInTheDocument();
    expect(screen.getByText("Papel")).toBeInTheDocument();
  });
});
