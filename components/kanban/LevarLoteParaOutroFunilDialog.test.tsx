/**
 * "Levar selecionados para outro funil" — o que a janela diz ANTES de levar.
 *
 * O laço (um de cada vez, recusa por negócio, teto) é provado em
 * `lib/kanban/levar-em-lote.test.ts`. Aqui:
 *
 *  1. a contagem do que foi selecionado, e "Levar" desabilitado sem destino;
 *  2. acima do teto, a janela avisa ANTES que só os 50 primeiros vão;
 *  3. instalação com um funil só diz por que não há destino.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/hooks/kanban/useDestinosDeFunil", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useDestinosDeFunil: vi.fn(),
}));

import { useDestinosDeFunil } from "@/hooks/kanban/useDestinosDeFunil";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { LevarLoteParaOutroFunilDialog } from "./LevarLoteParaOutroFunilDialog";

function comCliente(ui: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

function destinos(lista: Array<{ id: string; name: string }>) {
  vi.mocked(useDestinosDeFunil).mockReturnValue({ data: lista } as never);
}

beforeEach(() => vi.clearAllMocks());

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

describe("LevarLoteParaOutroFunilDialog", () => {
  it("diz quantos vão, e não leva sem destino escolhido", () => {
    destinos([{ id: "p2", name: "Pós-venda" }]);
    render(
      comCliente(
        <LevarLoteParaOutroFunilDialog open onOpenChange={() => {}} pipelineId="p1" leadIds={["a", "b", "c"]} />,
      ),
    );

    expect(screen.getByText(/3 negócios selecionados\./)).toBeTruthy();
    expect((screen.getByTestId("confirmar-lote") as HTMLButtonElement).disabled).toBe(true);
  });

  it("acima do teto, avisa antes que só os 50 primeiros vão", () => {
    destinos([{ id: "p2", name: "Pós-venda" }]);
    const ids = Array.from({ length: 53 }, (_, i) => `id-${i}`);
    render(
      comCliente(<LevarLoteParaOutroFunilDialog open onOpenChange={() => {}} pipelineId="p1" leadIds={ids} />),
    );

    expect(screen.getByText(/Só os 50 primeiros serão levados nesta vez\./)).toBeTruthy();
  });

  it("com um funil só, explica por que não há para onde levar", () => {
    destinos([]);
    render(
      comCliente(<LevarLoteParaOutroFunilDialog open onOpenChange={() => {}} pipelineId="p1" leadIds={["a"]} />),
    );

    expect(screen.getByText(/Este é o único funil/)).toBeTruthy();
  });

  it("shows the created deal and refreshes its board after a partial failure", async () => {
    const pipeline = {
      id: "p2",
      name: "Pós-venda",
      stages: [{ id: "s1", name: "Novo", position: 1, is_won: false, is_lost: false }],
    };
    destinos([pipeline]);
    const cloneId = "a1b2c3d4-1111-4111-8111-111111111111";
    const post = vi
      .spyOn(apiClient, "post")
      .mockRejectedValueOnce(
        new ApiError(500, "internal_error", { cloned_lead_id: cloneId }, "qa-1", "Falha ao vincular a origem"),
      )
      .mockRejectedValueOnce(
        new ApiError(422, "required_fields_missing", undefined, "qa-2", "Campos obrigatórios faltando"),
      );
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <LevarLoteParaOutroFunilDialog open onOpenChange={vi.fn()} pipelineId="p1" leadIds={["a", "b"]} />
      </QueryClientProvider>,
    );

    try {
      await user.click(screen.getByRole("combobox", { name: "Funil de destino" }));
      await user.click(await screen.findByRole("option", { name: "Pós-venda" }));
      await user.click(screen.getByRole("button", { name: "Levar" }));

      const result = within(await screen.findByTestId("resultado-do-lote"));
      expect(result.getByText("0 de 2 negócios levados.")).toBeInTheDocument();
      expect(result.getByText(/Campos obrigatórios faltando/)).toBeInTheDocument();
      expect(result.getByRole("link", { name: "Abrir negócio" })).toHaveAttribute(
        "href",
        `/app/leads/${cloneId}`,
      );
      expect(post).toHaveBeenCalledTimes(2);
      await waitFor(() => {
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["board", "p2"] });
      });
    } finally {
      post.mockRestore();
    }
  });
});
