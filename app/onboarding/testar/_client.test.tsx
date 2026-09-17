import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/actions/onboarding/marcarTeste", () => ({
  marcarTesteFeito: vi.fn(),
  pularTeste: vi.fn(),
}));

import { TestarClient } from "@/app/onboarding/testar/_client";

describe("ensaio interno com rascunho configurado", () => {
  it("com versão em rascunho mostra o formulário de ensaio, não o bloqueio antigo", () => {
    render(
      <TestarClient
        nome="Assistente Sigilium"
        agenteId="aaaaaaaa-0000-4000-8000-000000000001"
        versaoId="bbbbbbbb-0000-4000-8000-000000000002"
        noAr={false}
      />,
    );
    expect(screen.getByTestId("aviso-ensaio-sem-canal")).toHaveTextContent(
      "Você pode testar este agente aqui. Para atender clientes, conecte um canal.",
    );
    expect(screen.getByRole("button", { name: "Mandar mensagem" })).toBeEnabled();
    expect(
      screen.queryByText(/Rascunho não responde mensagem, então não há o que ensaiar/i),
    ).not.toBeInTheDocument();
  });

  it("sem versão continua sem o que ensaiar", () => {
    render(
      <TestarClient
        nome="Assistente Sigilium"
        agenteId="aaaaaaaa-0000-4000-8000-000000000001"
        versaoId={null}
        noAr={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Mandar mensagem" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("ainda não foi para o ar.");
  });
});
