/**
 * O diálogo chamava `rename.mutate` só com `onSuccess`. Quando o PATCH falhava
 * (nome já usado, rede), a tela não dizia nada: o botão voltava do "Salvando…"
 * e o usuário clicava de novo achando que o clique não pegou.
 *
 * O teste guarda o COMPORTAMENTO — o erro aparece e o nome digitado sobrevive.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RenameFollowupFlowDialog } from "./RenameFollowupFlowDialog";

const renomear = vi.fn();
vi.mock("@/hooks/followup/useFollowupFlow", () => ({
  useRenameFollowupFlow: () => ({ mutate: renomear, isPending: false }),
}));

interface OpcoesDeMutacao {
  onSuccess?: () => void;
  onError?: (erro: unknown) => void;
}

function respondeCom(resposta: (opts: OpcoesDeMutacao) => void): void {
  renomear.mockImplementation((...args: unknown[]) => {
    const opts = args[1] as OpcoesDeMutacao | undefined;
    if (opts) resposta(opts);
  });
}

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RenameFollowupFlowDialog
        flowId="fluxo-1"
        flowName="Carrinho abandonado"
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

async function envia(nome: string): Promise<HTMLElement> {
  const user = userEvent.setup({ delay: null });
  montar();
  const campo = screen.getByLabelText("Nome");
  await user.clear(campo);
  await user.type(campo, nome);
  await user.click(screen.getByRole("button", { name: "Salvar" }));
  return campo;
}

describe("RenameFollowupFlowDialog — o PATCH que falha não pode sumir", () => {
  beforeEach(() => renomear.mockReset());

  it("mostra a mensagem do servidor e mantém o nome digitado", async () => {
    respondeCom((opts) => opts.onError?.(new Error("Já existe um fluxo com este nome.")));

    const campo = await envia("Outro nome");

    expect(await screen.findByRole("alert")).toHaveTextContent("Já existe um fluxo com este nome.");
    expect(campo).toHaveValue("Outro nome");
  });

  it("erro sem mensagem ainda vira frase de gente, nunca silêncio", async () => {
    respondeCom((opts) => opts.onError?.(new Error("")));

    await envia("Qualquer coisa");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não consegui renomear o fluxo. Tente de novo.",
    );
  });

  it("sucesso não deixa alerta na tela", async () => {
    respondeCom((opts) => opts.onSuccess?.());

    await envia("Nome novo");

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
