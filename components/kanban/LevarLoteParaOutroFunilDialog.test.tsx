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

// O idioma é trocável por caso: a contagem do diálogo tem de tratar o singular
// e o rótulo em espanhol é o canônico do produto (#5024).
const idioma = vi.hoisted(() => ({ atual: "pt-BR" as "pt-BR" | "es" }));
vi.mock("@/hooks/i18n/useT", async () => {
  const { traduzir } = await import("@/lib/i18n/dicionario");
  return { useT: () => (chave: string) => traduzir(chave, idioma.atual) };
});

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

beforeEach(() => {
  vi.clearAllMocks();
  idioma.atual = "pt-BR";
});

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

  // #5024: a frase da janela dizia "1 negócios selecionados." — plural com um
  // só. O molde é o mesmo da barra (`BulkActionBar`): o singular nomeia o
  // negócio e usa "selecionado"; do plural em diante, a contagem basta.
  it("1 selecionado fala no singular", () => {
    idioma.atual = "pt-BR";
    destinos([{ id: "p2", name: "Pós-venda" }]);
    render(
      comCliente(<LevarLoteParaOutroFunilDialog open onOpenChange={() => {}} pipelineId="p1" leadIds={["a"]} />),
    );

    expect(screen.getByText("1 negócio selecionado.")).toBeTruthy();
    expect(screen.queryByText(/negócios selecionados/)).not.toBeInTheDocument();
  });

  it("2 selecionados continua no plural", () => {
    idioma.atual = "pt-BR";
    destinos([{ id: "p2", name: "Pós-venda" }]);
    render(
      comCliente(<LevarLoteParaOutroFunilDialog open onOpenChange={() => {}} pipelineId="p1" leadIds={["a", "b"]} />),
    );

    expect(screen.getByText("2 negócios selecionados.")).toBeTruthy();
  });

  it("em espanhol: singular tratado e o motivo é o rótulo canônico \"Movido a otro embudo\"", () => {
    idioma.atual = "es";
    destinos([{ id: "p2", name: "Pós-venda" }]);
    render(
      comCliente(<LevarLoteParaOutroFunilDialog open onOpenChange={() => {}} pipelineId="p1" leadIds={["a"]} />),
    );

    expect(screen.getByText("1 negocio seleccionado.")).toBeTruthy();
    expect(screen.getByText(/Movido a otro embudo/)).toBeInTheDocument();
    // O rótulo antigo não pode voltar — montado por partes para o próprio
    // teste não reintroduzir a string que a issue manda sumir do repositório.
    expect(screen.queryByText(new RegExp(["Llevado", "a", "otro", "embudo"].join(" ")))).not.toBeInTheDocument();
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

  it("ao fechar depois de uma falha parcial, limpa a seleção: o negócio já tem cópia no destino", async () => {
    const pipeline = {
      id: "p2",
      name: "Pós-venda",
      stages: [{ id: "s1", name: "Novo", position: 1, is_won: false, is_lost: false }],
    };
    destinos([pipeline]);
    const post = vi
      .spyOn(apiClient, "post")
      .mockRejectedValueOnce(
        new ApiError(500, "internal_error", { cloned_lead_id: "clone-de-a" }, "qa-1", "Falha ao vincular a origem"),
      )
      .mockRejectedValueOnce(
        new ApiError(422, "required_fields_missing", undefined, "qa-2", "Campos obrigatórios faltando"),
      );
    const onConcluido = vi.fn();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LevarLoteParaOutroFunilDialog
          open
          onOpenChange={vi.fn()}
          pipelineId="p1"
          leadIds={["a", "b"]}
          onConcluido={onConcluido}
        />
      </QueryClientProvider>,
    );

    try {
      await user.click(screen.getByRole("combobox", { name: "Funil de destino" }));
      await user.click(await screen.findByRole("option", { name: "Pós-venda" }));
      await user.click(screen.getByRole("button", { name: "Levar" }));
      await screen.findByTestId("resultado-do-lote");

      await user.click(within(screen.getByTestId("levar-lote-para-outro-funil")).getAllByRole("button", { name: "Fechar" })[0]!);

      // Qualquer cópia criada no destino conta como efeito: a seleção inteira
      // é limpa (mesma regra de antes, agora também para quem falhou depois do
      // clone nascer). Sem isso, o "Levar" seguinte recriava o negócio.
      expect(onConcluido).toHaveBeenCalledTimes(1);
      expect(onConcluido).toHaveBeenCalledWith();
    } finally {
      post.mockRestore();
    }
  });

  it("ao fechar depois de levar todos, limpa a seleção", async () => {
    const pipeline = {
      id: "p2",
      name: "Pós-venda",
      stages: [{ id: "s1", name: "Novo", position: 1, is_won: false, is_lost: false }],
    };
    destinos([pipeline]);
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ data: {} } as never);
    const onConcluido = vi.fn();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LevarLoteParaOutroFunilDialog
          open
          onOpenChange={vi.fn()}
          pipelineId="p1"
          leadIds={["a", "b"]}
          onConcluido={onConcluido}
        />
      </QueryClientProvider>,
    );

    try {
      await user.click(screen.getByRole("combobox", { name: "Funil de destino" }));
      await user.click(await screen.findByRole("option", { name: "Pós-venda" }));
      await user.click(screen.getByRole("button", { name: "Levar" }));
      await screen.findByTestId("resultado-do-lote");

      await user.click(within(screen.getByTestId("levar-lote-para-outro-funil")).getAllByRole("button", { name: "Fechar" })[0]!);

      expect(onConcluido).toHaveBeenCalledTimes(1);
      expect(onConcluido).toHaveBeenCalledWith();
    } finally {
      post.mockRestore();
    }
  });

  it("ao fechar sem nenhuma cópia criada, não mexe na seleção", async () => {
    const pipeline = {
      id: "p2",
      name: "Pós-venda",
      stages: [{ id: "s1", name: "Novo", position: 1, is_won: false, is_lost: false }],
    };
    destinos([pipeline]);
    const post = vi
      .spyOn(apiClient, "post")
      .mockRejectedValueOnce(
        new ApiError(422, "required_fields_missing", undefined, "qa-1", "Campos obrigatórios faltando"),
      );
    const onConcluido = vi.fn();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LevarLoteParaOutroFunilDialog
          open
          onOpenChange={vi.fn()}
          pipelineId="p1"
          leadIds={["a"]}
          onConcluido={onConcluido}
        />
      </QueryClientProvider>,
    );

    try {
      await user.click(screen.getByRole("combobox", { name: "Funil de destino" }));
      await user.click(await screen.findByRole("option", { name: "Pós-venda" }));
      await user.click(screen.getByRole("button", { name: "Levar" }));
      await screen.findByTestId("resultado-do-lote");

      await user.click(within(screen.getByTestId("levar-lote-para-outro-funil")).getAllByRole("button", { name: "Fechar" })[0]!);

      expect(onConcluido).not.toHaveBeenCalled();
    } finally {
      post.mockRestore();
    }
  });
});
