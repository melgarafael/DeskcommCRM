// components/connections/FunilDeEntradaDoNumero.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";

import { FunilDeEntradaDoNumero } from "./FunilDeEntradaDoNumero";

/**
 * #5142: com o interruptor "conversas novas criam negócio" DESLIGADO, o seletor
 * não pode continuar dizendo que os contatos entram no funil — nada nasce no
 * funil, e o seletor fica sem efeito. Ligado, ou com a prop ausente (Canal
 * Parceiro, Redes Sociais, onde o interruptor não existe), a tela é a de hoje.
 */
vi.mock("@/lib/api/client");
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

const ENTRADA = {
  entry_pipeline_id: "funil-1",
  entry_stage_id: null,
  funis: [{ id: "funil-1", name: "Pedidos", is_default: true, etapas: [] }],
};

function renderizar(props: { channelId: string; criaNegocio?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FunilDeEntradaDoNumero {...props} />
    </QueryClientProvider>,
  );
}

describe("FunilDeEntradaDoNumero — interruptor de negócio desligado (#5142)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.get).mockResolvedValue({ data: ENTRADA } as never);
  });

  it("criaNegocio=false: botão desabilitado e a frase 'Contatos novos entram' some", async () => {
    renderizar({ channelId: "canal-1", criaNegocio: false });

    const botao = await screen.findByRole("button", { name: "Funil de entrada" });
    // Espera a leitura do seletor terminar: a frase tem de sumir por causa do
    // interruptor, não porque o cartão ainda está carregando.
    await waitFor(() => expect(screen.queryByText("Carregando…")).not.toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledWith("/api/v1/channel-sessions/canal-1/entrada");
    // A escolha CONTINUA na tela (é ali que o admin a edita quando religar),
    // mas não se apresenta como editável com efeito.
    expect(botao).toBeDisabled();
    expect(screen.getByTestId("funil-de-entrada-canal-1")).toHaveTextContent(
      "Sem efeito enquanto a opção acima estiver desligada",
    );
    expect(screen.queryByText(/Contatos novos entram/)).not.toBeInTheDocument();
  });

  it("criaNegocio=true: comportamento de hoje, com a frase e o botão habilitado", async () => {
    renderizar({ channelId: "canal-2", criaNegocio: true });

    expect(await screen.findByText(/Contatos novos entram no funil Pedidos/)).toBeInTheDocument();
    // Habilitado depois de a escolha carregar — mesmo desenho de antes.
    const botao = screen.getByRole("button", { name: "Funil de entrada" });
    await waitFor(() => expect(botao).toBeEnabled());
    expect(screen.queryByText("Sem efeito enquanto a opção acima estiver desligada")).not.toBeInTheDocument();
  });

  it("sem a prop (Canal Parceiro, Redes Sociais): comportamento de hoje intacto", async () => {
    renderizar({ channelId: "canal-3" });

    expect(await screen.findByText(/Contatos novos entram no funil Pedidos/)).toBeInTheDocument();
    const botao = screen.getByRole("button", { name: "Funil de entrada" });
    await waitFor(() => expect(botao).toBeEnabled());
    expect(screen.queryByText("Sem efeito enquanto a opção acima estiver desligada")).not.toBeInTheDocument();
  });
});
