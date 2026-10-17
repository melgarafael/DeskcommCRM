/**
 * A janela de importação mostra, no lugar onde a pessoa está olhando, (a) cada
 * problema de um arquivo recusado, com o caminho até o campo, e (b) depois de
 * importar, o que precisa ser resolvido antes de publicar — separado do que foi
 * ajustado sozinho. Um toast que some não serviria para nenhum dos dois.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { ImportFlowDialog } from "./ImportFlowDialog";

const importar = vi.fn();
vi.mock("@/hooks/followup/useFollowupFlows", () => ({
  useImportFollowupFlow: () => ({ mutate: importar, isPending: false }),
}));

interface Opcoes {
  onSuccess?: (data: unknown) => void;
  onError?: (erro: unknown) => void;
}

function respondeCom(resposta: (opts: Opcoes) => void): void {
  importar.mockImplementation((...args: unknown[]) => {
    const opts = args[1] as Opcoes | undefined;
    if (opts) resposta(opts);
  });
}

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ImportFlowDialog open onOpenChange={() => {}} baseHref="/app/ai/followups" />
    </QueryClientProvider>,
  );
}

async function colaEImporta(texto: string) {
  const user = userEvent.setup({ delay: null });
  montar();
  // `fireEvent.change` e não `user.type`: o userEvent interpreta `{` como tecla especial.
  fireEvent.change(screen.getByLabelText("Ou cole o conteúdo do arquivo"), {
    target: { value: texto },
  });
  await user.click(screen.getByRole("button", { name: "Importar" }));
}

describe("ImportFlowDialog", () => {
  beforeEach(() => importar.mockReset());

  it("JSON quebrado é recusado na própria tela, sem chamar o servidor", async () => {
    await colaEImporta("{ isto não é json");
    expect(await screen.findByRole("alert")).toHaveTextContent("O conteúdo não é um JSON válido.");
    expect(importar).not.toHaveBeenCalled();
  });

  it("arquivo recusado lista cada problema com o caminho até o campo", async () => {
    respondeCom((opts) =>
      opts.onError?.(
        new ApiError(
          422,
          "invalid_flow_file",
          { problemas: ["flow.graph.nodes.1.config.duration_ms: muito pequeno"] },
          "r1",
          "O arquivo não é um fluxo válido. Confira os itens abaixo e tente de novo.",
        ),
      ),
    );
    await colaEImporta('{"flow":{}}');
    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("O arquivo não é um fluxo válido.");
    expect(alerta).toHaveTextContent("flow.graph.nodes.1.config.duration_ms: muito pequeno");
  });

  it("depois de importar, separa o que bloqueia do que foi ajustado e leva ao fluxo", async () => {
    respondeCom((opts) =>
      opts.onSuccess?.({
        flow: { id: "f1", name: "Retomada (importado)" },
        pendencias: [
          {
            codigo: "etapa_nao_encontrada",
            bloqueia: true,
            no: { id: "m1", label: "Mover" },
            referencia: "Proposta · Vendas",
          },
          { codigo: "responsavel_trocado", bloqueia: false, no: { id: "t1", label: "Ligar" } },
        ],
      }),
    );
    await colaEImporta('{"flow":{}}');
    expect(await screen.findByText("Retomada (importado)")).toBeInTheDocument();
    expect(screen.getByText("Resolva antes de publicar:")).toBeInTheDocument();
    expect(screen.getByText(/«Mover»: a etapa não existe nesta conta/)).toHaveTextContent(
      "(Proposta · Vendas)",
    );
    expect(screen.getByText("Ajustado automaticamente:")).toBeInTheDocument();
    expect(screen.getByText(/«Ligar»: a pessoa da tarefa não é desta conta/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir o fluxo" })).toHaveAttribute(
      "href",
      "/app/ai/followups/f1",
    );
  });

  it("nome digitado vai junto; em branco, não manda o campo", async () => {
    const user = userEvent.setup({ delay: null });
    montar();
    fireEvent.change(screen.getByLabelText("Ou cole o conteúdo do arquivo"), {
      target: { value: '{"a":1}' },
    });
    await user.type(screen.getByLabelText("Nome (opcional)"), "Clínica B");
    await user.click(screen.getByRole("button", { name: "Importar" }));
    expect(importar.mock.calls[0]![0]).toEqual({ file: { a: 1 }, name: "Clínica B" });
  });
});
