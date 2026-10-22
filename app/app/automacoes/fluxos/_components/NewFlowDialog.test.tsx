/**
 * O diálogo chamava `create.mutate` só com `onSuccess`. Quando o POST falhava,
 * a tela não dizia nada: o botão voltava do "Criando…", o diálogo continuava
 * aberto e o usuário clicava de novo achando que o clique não pegou.
 *
 * O teste guarda o COMPORTAMENTO — o erro aparece e o que foi digitado
 * sobrevive —, não a existência de um `onError`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NewFlowDialog } from "./NewFlowDialog";

const criar = vi.fn();
vi.mock("@/hooks/followup/useFollowupFlows", () => ({
  useCreateFollowupFlow: () => ({ mutate: criar, isPending: false }),
}));

interface OpcoesDeMutacao {
  onSuccess?: () => void;
  onError?: (erro: unknown) => void;
}

/**
 * Lê o 2º argumento sem destruturar. Destruturando, uma chamada sem opções
 * derruba o teste com `Cannot read properties of undefined` — um TypeError que
 * se parece com defeito do componente e não é.
 */
function respondeCom(resposta: (opts: OpcoesDeMutacao) => void): void {
  criar.mockImplementation((...args: unknown[]) => {
    const opts = args[1] as OpcoesDeMutacao | undefined;
    if (opts) resposta(opts);
  });
}

function montar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NewFlowDialog open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

async function preencheEEnvia(nome: string): Promise<HTMLElement> {
  const user = userEvent.setup({ delay: null });
  montar();
  const campo = screen.getByLabelText("Nome");
  await user.type(campo, nome);
  await user.click(screen.getByRole("button", { name: "Criar fluxo" }));
  return campo;
}

describe("NewFlowDialog — o POST que falha não pode sumir", () => {
  beforeEach(() => criar.mockReset());

  it("mostra a mensagem do servidor e mantém o nome digitado", async () => {
    respondeCom((opts) => opts.onError?.(new Error("Já existe um fluxo com esse nome.")));

    const campo = await preencheEEnvia("Recuperação de carrinho");

    expect(await screen.findByRole("alert")).toHaveTextContent("Já existe um fluxo com esse nome.");
    // Fechar ou limpar aqui obrigaria a redigitar — o erro é do servidor, não do texto.
    expect(campo).toHaveValue("Recuperação de carrinho");
  });

  it("erro sem mensagem ainda vira frase de gente, nunca silêncio", async () => {
    respondeCom((opts) => opts.onError?.(new Error("")));

    await preencheEEnvia("Qualquer coisa");

    expect(await screen.findByRole("alert")).toHaveTextContent("Não consegui criar o fluxo. Tente de novo.");
  });

  it("sucesso não deixa alerta na tela", async () => {
    respondeCom((opts) => opts.onSuccess?.());

    await preencheEEnvia("Fluxo bom");

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
