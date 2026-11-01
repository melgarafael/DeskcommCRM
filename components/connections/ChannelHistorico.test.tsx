import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import { toast } from "sonner";

import { ChannelHistorico } from "./ChannelHistorico";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const previa = { conversas: 12, mensagens: 340, audios: 20, imagens: 5, desde: "2026-09-20T00:00:00Z", parcial: false };
const resposta = (guardar: boolean, importacao: unknown) => ({ data: { guardar_historico: guardar, importacao } });

function tela() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChannelHistorico channelId="c1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  vi.mocked(toast.error).mockReset();
});

describe("ChannelHistorico", () => {
  it("sem guardar_historico mostra o aviso e esconde o botão", async () => {
    get.mockResolvedValue(resposta(false, null));
    tela();
    expect(await screen.findByText(/Ligue 'Guardar o histórico' e conecte o número de novo/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ver prévia" })).toBeNull();
  });

  it("a prévia mostra os quatro números e a frase da IA", async () => {
    get.mockResolvedValue(resposta(true, { id: "i1", status: "previa", dias: 30, previa }));
    tela();
    expect(await screen.findByText("12 conversas, 340 mensagens, 20 áudios e 5 imagens")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma mensagem antiga será respondida pela IA nem dispara automação.")).toBeInTheDocument();
    expect(screen.getByText("Áudios e imagens antigos que o WhatsApp não guarda mais aparecem como indisponíveis.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Importar" })).toBeInTheDocument();
  });

  it("prévia parcial usa a frase 'Pelo menos'", async () => {
    get.mockResolvedValue(resposta(true, { id: "i1", status: "previa", dias: 90, previa: { ...previa, parcial: true } }));
    tela();
    expect(await screen.findByText("Pelo menos 12 conversas, 340 mensagens, 20 áudios e 5 imagens")).toBeInTheDocument();
  });

  it("clicar em Importar usa o id da prévia do GET", async () => {
    get.mockResolvedValue(resposta(true, { id: "i1", status: "previa", dias: 30, previa }));
    post.mockResolvedValue({ data: { importacao: { id: "i1", status: "rodando" } } });
    tela();
    fireEvent.click(await screen.findByRole("button", { name: "Importar" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/channel-sessions/c1/historico", { acao: "importar", importacaoId: "i1" }, expect.anything()));
  });

  it("durante rodando mostra o progresso e o botão Cancelar", async () => {
    get.mockResolvedValue(resposta(true, { id: "i1", status: "rodando", dias: 30, previa, conversas_feitas: 4 }));
    tela();
    expect(await screen.findByText("Importando: 4 de 12 conversas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeInTheDocument();
  });

  it("o período oferece 30, 90, 180 e 365 dias, e pede a prévia no escolhido", async () => {
    get.mockResolvedValue(resposta(true, null));
    post.mockResolvedValue({ data: {} });
    tela();
    const periodo = await screen.findByRole("combobox", { name: "Período: últimos 30, 90, 180 ou 365 dias" });
    expect([...(periodo as HTMLSelectElement).options].map((o) => o.value)).toEqual(["30", "90", "180", "365"]);
    fireEvent.change(periodo, { target: { value: "180" } });
    fireEvent.click(screen.getByRole("button", { name: "Ver prévia" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![1]).toMatchObject({ acao: "previa", dias: 180 });
  });

  it("pedir a prévia mostra 'Contando as conversas…' e erro do canal mostra a frase", async () => {
    get.mockResolvedValue(resposta(true, null));
    post.mockRejectedValue(new Error("502"));
    tela();
    fireEvent.click(await screen.findByRole("button", { name: "Ver prévia" }));
    expect(await screen.findByText("Contando as conversas…")).toBeInTheDocument();
    expect(await screen.findByText("Não foi possível falar com o número agora. Tente de novo em instantes.")).toBeInTheDocument();
  });

  it("status erro mostra a frase e 'Tentar de novo' retoma", async () => {
    get.mockResolvedValue(resposta(true, { id: "i1", status: "erro", dias: 30, previa, erro: "x" }));
    post.mockResolvedValue({ data: { importacao: { id: "i1", status: "rodando" } } });
    tela();
    expect(await screen.findByText("A importação parou por um erro.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/channel-sessions/c1/historico", { acao: "retomar", importacaoId: "i1" }, expect.anything()));
  });

  it("status erro mostra o erro resumido, sem citar o transporte, e permite Cancelar", async () => {
    const longo = `messages_consulta: ${["wa", "ha"].join("")} devolveu 414 Request-URI Too Large ${"x".repeat(300)}`;
    get.mockResolvedValue(resposta(true, { id: "i1", status: "erro", dias: 30, previa, erro: longo }));
    post.mockResolvedValue({ data: { importacao: { id: "i1", status: "cancelada" } } });
    const { container } = tela();
    const detalhe = await screen.findByText(/^Detalhe: messages_consulta: canal devolveu 414/);
    expect(detalhe.textContent!.length).toBeLessThan(200);
    expect(container.textContent).not.toMatch(new RegExp(["wa", "ha"].join(""), "i"));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/channel-sessions/c1/historico", { acao: "cancelar", importacaoId: "i1" }, expect.anything()));
  });

  it("409 numa ação diz que a importação mudou e recarrega o estado", async () => {
    get.mockResolvedValue(resposta(true, { id: "i1", status: "erro", dias: 30, previa, erro: "x" }));
    post.mockRejectedValue(new ApiError(409, "invalid_state_transition", undefined, "r1"));
    tela();
    fireEvent.click(await screen.findByRole("button", { name: "Tentar de novo" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("A importação mudou enquanto você olhava. A tela foi atualizada com o estado atual."),
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("falha de rede numa ação mostra a frase do número e também recarrega", async () => {
    get.mockResolvedValue(resposta(true, { id: "i1", status: "rodando", dias: 30, previa, conversas_feitas: 1 }));
    post.mockRejectedValue(new Error("fetch failed"));
    tela();
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Não foi possível falar com o número agora. Tente de novo em instantes."),
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("409 ao pedir a prévia diz que a importação mudou, não que o número não respondeu", async () => {
    get.mockResolvedValue(resposta(true, null));
    post.mockRejectedValue(new ApiError(409, "state_conflict", undefined, "r1"));
    tela();
    fireEvent.click(await screen.findByRole("button", { name: "Ver prévia" }));
    expect(await screen.findByText("A importação mudou enquanto você olhava. A tela foi atualizada com o estado atual.")).toBeInTheDocument();
    expect(screen.queryByText("Não foi possível falar com o número agora. Tente de novo em instantes.")).toBeNull();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("concluída mostra o resumo e permite nova prévia", async () => {
    get.mockResolvedValue(resposta(true, { id: "i1", status: "concluida", dias: 30, previa, mensagens_gravadas: 300, midias_indisponiveis: 7 }));
    tela();
    expect(await screen.findByText("Importação concluída")).toBeInTheDocument();
    expect(screen.getByText("300 mensagens trazidas; 7 áudios ou imagens não estavam mais disponíveis.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver prévia" })).toBeInTheDocument();
  });

  it("nenhuma frase menciona o transporte", async () => {
    get.mockResolvedValue(resposta(true, { id: "i1", status: "previa", dias: 30, previa }));
    const { container } = tela();
    await screen.findByText(/12 conversas/);
    expect(container.textContent).not.toMatch(new RegExp(["wa", "ha"].join(""), "i"));
  });
});
