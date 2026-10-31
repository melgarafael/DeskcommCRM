import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ListaDoFunil } from "./ListaDoFunil";
import type { LeadFilters } from "@/lib/kanban/filters";
import type { Pipeline, Stage } from "@/lib/kanban/types";

/**
 * A ABA LISTA LEVA A ESCOLHA DA BARRA PARA A CONSULTA (#3172, fatia 2).
 *
 * O que se mede aqui é o lado da TELA: o que a Lista pede ao hook (e, por ele,
 * à rota) para cada escolha da barra, que filtro novo volta para a página 1, e
 * que o filtro que a Lista ainda não aplica é DITO na tela. O lado da rota está
 * em `app/api/v1/pipelines/[id]/leads/filtros.test.ts`.
 */
const { useLeadsPaginados } = vi.hoisted(() => ({ useLeadsPaginados: vi.fn() }));

vi.mock("@/hooks/kanban/useLeadsPaginados", () => ({
  LEADS_POR_PAGINA: 50,
  useLeadsPaginados: (...args: unknown[]) => useLeadsPaginados(...args),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
// A ficha é a mesma do quadro: abri-la aqui mediria a ficha, não a aba.
vi.mock("./LeadDossier", () => ({ LeadDossier: () => null }));

const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL = { id: "p-1", name: "Vendas", vocabulary: null, settings: {} } as unknown as Pipeline;
const ETAPAS = [
  { id: "e-1", name: "Prospecção", position: 0, is_won: false, is_lost: false },
] as unknown as Stage[];

const PAGINA = {
  leads: [{ id: "l-1", title: "Negócio A", stage_id: "e-1", value_cents: null, currency: null }],
  page: 1,
  perPage: 50,
  hasMore: true,
};

function montar(filtros: LeadFilters) {
  return render(<ListaDoFunil pipelineId="p-1" pipeline={FUNIL} stages={ETAPAS} filtros={filtros} />);
}

beforeEach(() => {
  useLeadsPaginados.mockReset();
  useLeadsPaginados.mockReturnValue({ data: PAGINA, isLoading: false, error: null });
});

describe("a Lista e a barra de filtros", () => {
  it("⭐ Responsável e Status da barra vão para o pedido da página", () => {
    montar({ owner: ANA, status: "open" });

    expect(useLeadsPaginados).toHaveBeenLastCalledWith("p-1", 1, { owner: ANA, status: "open" });
  });

  it("\"Todos\" da barra (`any`/`all`) não vira filtro: o funil inteiro", () => {
    montar({ owner: "any", status: "all" });

    expect(useLeadsPaginados).toHaveBeenLastCalledWith("p-1", 1, {});
  });

  it("filtro NOVO volta para a página 1 — a página 2 de antes não é a 2 de agora", async () => {
    const { rerender } = montar({});
    await userEvent.click(screen.getByRole("button", { name: "Próxima" }));
    expect(useLeadsPaginados).toHaveBeenLastCalledWith("p-1", 2, {});

    rerender(
      <ListaDoFunil pipelineId="p-1" pipeline={FUNIL} stages={ETAPAS} filtros={{ owner: ANA }} />,
    );

    expect(useLeadsPaginados).toHaveBeenLastCalledWith("p-1", 1, { owner: ANA });
  });

  it("filtro que a Lista ainda NÃO aplica é dito na tela, com o nome da barra", () => {
    montar({ owner: ANA, search: "pizzaria", tag: ["vip"], overdueOnly: true });

    const aviso = screen.getByTestId("lista-filtros-fora");
    expect(aviso.textContent).toContain("Busca, Tag, Apenas atrasados");
    // O que ela aplica não entra no aviso — senão o aviso mentiria ao contrário.
    expect(aviso.textContent).not.toContain("Responsável");
  });

  it("só com o que a Lista aplica, nenhum aviso", () => {
    montar({ owner: ANA, status: "won" });

    expect(screen.queryByTestId("lista-filtros-fora")).toBeNull();
  });

  it("vazio com filtro diz \"com este filtro\", e não que o funil está vazio", () => {
    useLeadsPaginados.mockReturnValue({
      data: { leads: [], page: 1, perPage: 50, hasMore: false },
      isLoading: false,
      error: null,
    });
    montar({ owner: ANA });

    expect(screen.getByText("Nenhum negócio com este filtro.")).toBeTruthy();
  });
});
