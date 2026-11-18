/**
 * A ficha do contato e o painel da conversa mostram o que o roteiro coletou
 * (achado 1 da prova do #1130). Módulo desligado: não desenha nada nem pede nada.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ auth: vi.fn(), hook: vi.fn(), escolher: vi.fn() }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: deps.auth }));
vi.mock("@/hooks/contacts/useRoteirosDoContato", () => ({ useRoteirosDoContato: deps.hook }));
vi.mock("@/hooks/contacts/useEscolherNegocioDoRoteiro", () => ({
  useEscolherNegocioDoRoteiro: () => deps.escolher(),
}));

import { RoteirosDoContato } from "./RoteirosDoContato";

beforeEach(() => {
  vi.clearAllMocks();
  deps.escolher.mockReturnValue({ mutate: vi.fn(), isPending: false });
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

/**
 * #3363 — a decisão de produto exige ESCOLHA quando há mais de um card: a tela
 * não pode mostrar "o mais recente" como se fosse o destino. Um card só não se
 * pergunta (ele já é o vínculo da execução).
 */
describe("RoteirosDoContato — escolha do negócio (#3363)", () => {
  const roteiroCom = (negocio: unknown) => ({
    isLoading: false,
    data: [
      {
        enrollment_id: "e1",
        nome: "Qualificação",
        status: "coletando",
        iniciado_em: "2026-09-24T10:00:00Z",
        concluido_em: null,
        campos: [{ key: "destino_viagem", label: "Destino", valor: null, onde: "negocio" }],
        negocio,
      },
    ],
  });

  beforeEach(() => {
    deps.auth.mockReturnValue({ activeOrg: { modulos_ligados: ["fluxos_atendimento"] } });
  });

  it("dois negócios abertos: PEDE a escolha, sem default", () => {
    deps.hook.mockReturnValue(
      roteiroCom({
        vinculo: null,
        candidatos: [
          { id: "l1", titulo: "Viagem Chile" },
          { id: "l2", titulo: "Viagem Bahia" },
        ],
        escolha_pendente: true,
      }),
    );
    render(<RoteirosDoContato contactId="c1" />);

    const seletor = screen.getByTestId("roteiro-escolha-do-negocio") as HTMLSelectElement;
    expect(seletor).toBeTruthy();
    // Sem default: o valor inicial é vazio, e o botão só habilita com escolha.
    expect(seletor.value).toBe("");
    expect((screen.getByTestId("roteiro-confirmar-negocio") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Viagem Bahia")).toBeTruthy();
  });

  it("escolher manda o lead_id do card escolhido", async () => {
    const mutate = vi.fn();
    deps.escolher.mockReturnValue({ mutate, isPending: false });
    deps.hook.mockReturnValue(
      roteiroCom({
        vinculo: null,
        candidatos: [
          { id: "l1", titulo: "Viagem Chile" },
          { id: "l2", titulo: "Viagem Bahia" },
        ],
        escolha_pendente: true,
      }),
    );
    render(<RoteirosDoContato contactId="c1" />);

    await userEvent.selectOptions(screen.getByTestId("roteiro-escolha-do-negocio"), "l2");
    await userEvent.click(screen.getByTestId("roteiro-confirmar-negocio"));

    expect(mutate).toHaveBeenCalledWith({ enrollmentId: "e1", leadId: "l2" });
  });

  it("um negócio só: não pergunta e diz qual é o destino", () => {
    deps.hook.mockReturnValue(
      roteiroCom({
        vinculo: { id: "l1", titulo: "Viagem Chile" },
        candidatos: [{ id: "l1", titulo: "Viagem Chile" }],
        escolha_pendente: false,
      }),
    );
    render(<RoteirosDoContato contactId="c1" />);

    expect(screen.queryByTestId("roteiro-escolha-do-negocio")).toBeNull();
    expect(screen.getByTestId("roteiro-negocio-fixado").textContent).toContain("Viagem Chile");
  });
});
