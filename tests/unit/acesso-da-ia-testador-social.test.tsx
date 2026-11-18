/**
 * O PAINEL "CONFIGURAR ACESSO DA IA" DE UMA REDE SOCIAL ESCOLHE TESTADORES.
 *
 * Contato de Instagram/Facebook não tem telefone, então a lista de números não
 * o alcançava: o painel social só sabia pausar ou abrir ao público. Agora ele
 * lista os contatos que JÁ conversaram com aquele canal (a rota devolve
 * `social_candidates` quando o painel pede `?candidatos=sociais`), e marcar um
 * deles grava a identidade social exata — ninguém digita id.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const CANAL = "22222222-2222-4222-8222-222222222222";
const TESTADOR = "instagram:6af9e0ef28984e27de07bef4:1011223655361506";
const OUTRO = "instagram:6af9e0ef28984e27de07bef4:999";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { ChannelAiAccess } from "@/components/connections/ChannelAiAccess";

function abrir(props: { socialTesting?: boolean } = { socialTesting: true }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ChannelAiAccess channelId={CANAL} phoneTesting={false} {...props} />
    </QueryClientProvider>,
  );
}

describe("acesso da IA numa rede social — testadores por conta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({
      data: {
        mode: "pre_go_live",
        test_phone_numbers: [],
        test_social_identities: [],
        social_candidates: [
          { social_identity: TESTADOR, name: "WB" },
          { social_identity: OUTRO, name: null },
        ],
      },
    });
    api.patch.mockImplementation(async (_url: string, body: unknown) => ({ data: body }));
  });

  it("pede os candidatos do próprio canal e grava só a conta marcada", async () => {
    abrir();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/api/v1/channel-sessions/${CANAL}/ai-access?candidatos=sociais`));
    expect(await screen.findByText("IA pausada")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Configurar acesso da IA" }));
    const wb = await screen.findByRole("checkbox", { name: /WB/ });
    // Sem nome, a conta ainda é reconhecível pela rede e pelo fim do id.
    expect(screen.getByText("Instagram · …361506")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Sem nome/ })).not.toBeChecked();

    fireEvent.click(wb);
    fireEvent.click(screen.getByRole("button", { name: "Salvar contas de teste" }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch).toHaveBeenCalledWith(`/api/v1/channel-sessions/${CANAL}/ai-access`, {
      mode: "pre_go_live",
      test_phone_numbers: [],
      test_social_identities: [TESTADOR],
    });
  });

  it("sem nenhuma conta marcada, o botão continua sendo o de pausar", async () => {
    abrir();
    fireEvent.click(await screen.findByRole("button", { name: "Configurar acesso da IA" }));
    await screen.findByRole("checkbox", { name: /WB/ });
    expect(screen.getByRole("button", { name: "Pausar respostas da IA" })).toBeInTheDocument();
  });

  it("canal social com conta autorizada aparece EM TESTE, não pausado", async () => {
    api.get.mockResolvedValue({
      data: { mode: "pre_go_live", test_phone_numbers: [], test_social_identities: [TESTADOR], social_candidates: [] },
    });
    abrir();
    expect(await screen.findByText("IA em modo de teste")).toBeInTheDocument();
    expect(screen.getByText("1 conta de teste autorizada")).toBeInTheDocument();
  });

  it("sem socialTesting (Telegram), o painel não pede candidatos nem manda a lista social", async () => {
    abrir({ socialTesting: false });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/api/v1/channel-sessions/${CANAL}/ai-access`));
    fireEvent.click(await screen.findByRole("button", { name: "Configurar acesso da IA" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pausar respostas da IA" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(api.patch.mock.calls[0]![1]).toEqual({ mode: "pre_go_live", test_phone_numbers: [] });
  });
});
