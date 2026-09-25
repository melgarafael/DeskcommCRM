/**
 * A ficha do contato e o painel da conversa mostram o que o roteiro coletou
 * (achado 1 da prova do #1130). Módulo desligado: não desenha nada nem pede nada.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ auth: vi.fn(), hook: vi.fn() }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: deps.auth }));
vi.mock("@/hooks/contacts/useRoteirosDoContato", () => ({ useRoteirosDoContato: deps.hook }));

import { RoteirosDoContato } from "./RoteirosDoContato";

beforeEach(() => {
  vi.clearAllMocks();
  deps.hook.mockReturnValue({
    isLoading: false,
    data: [
      {
        enrollment_id: "e1",
        nome: "Cadastro",
        status: "coletando",
        iniciado_em: "2026-09-24T10:00:00Z",
        concluido_em: null,
        campos: [
          { key: "nome_completo", label: "Nome completo", valor: "Lia Mendes" },
          { key: "cpf", label: "CPF", valor: null },
        ],
      },
    ],
  });
});

describe("RoteirosDoContato", () => {
  it("módulo desligado: nada na tela e nenhum pedido", () => {
    deps.auth.mockReturnValue({ activeOrg: { modulos_ligados: [] } });
    const { container } = render(<RoteirosDoContato contactId="c1" />);
    expect(container.innerHTML).toBe("");
    expect(deps.hook).toHaveBeenCalledWith("c1", false);
  });

  it("ligado: o nome do roteiro, o status legível e cada pergunta com a resposta", () => {
    deps.auth.mockReturnValue({ activeOrg: { modulos_ligados: ["fluxos_atendimento"] } });
    render(<RoteirosDoContato contactId="c1" />);
    expect(screen.getByText("Cadastro")).toBeTruthy();
    expect(screen.getByText("Coletando respostas do roteiro")).toBeTruthy();
    expect(screen.getByTestId("roteiro-campo-nome_completo").textContent).toContain("Lia Mendes");
    expect(screen.getByTestId("roteiro-campo-cpf").textContent).toContain("não respondido");
  });
});
