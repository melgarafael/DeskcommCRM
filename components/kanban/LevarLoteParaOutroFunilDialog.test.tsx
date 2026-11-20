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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/hooks/kanban/useDestinosDeFunil", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useDestinosDeFunil: vi.fn(),
}));

import { useDestinosDeFunil } from "@/hooks/kanban/useDestinosDeFunil";
import { LevarLoteParaOutroFunilDialog } from "./LevarLoteParaOutroFunilDialog";

function comCliente(ui: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
}

function destinos(lista: Array<{ id: string; name: string }>) {
  vi.mocked(useDestinosDeFunil).mockReturnValue({ data: lista } as never);
}

beforeEach(() => vi.clearAllMocks());

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
});
