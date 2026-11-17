import { beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CanalBotClient } from "./CanalBotClient";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: h.get, post: h.post, delete: h.remove } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("./ChannelAiAccess", () => ({ ChannelAiAccess: () => <div>IA pausada</div> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const desconectado = {
  label: "Robô",
  connected: false,
  channel_session_id: null,
  bot_id: null,
  display_name: null,
  status: null,
  has_token: false,
  webhook_url: null,
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CanalBotClient />
    </QueryClientProvider>,
  );
}

it("conecta com o token colado e limpa o campo — o token não volta para a tela", async () => {
  h.get.mockResolvedValue({ data: desconectado });
  h.post.mockResolvedValue({ data: { connected: true } });
  mount();
  await screen.findByText("Não conectado");

  const campo = screen.getByLabelText("Token do robô") as HTMLInputElement;
  const botao = screen.getByRole("button", { name: "Conectar" });
  expect(botao).toHaveProperty("disabled", true);

  fireEvent.change(campo, { target: { value: "123456789:AAH-um-token-bem-comprido" } });
  fireEvent.click(botao);

  await waitFor(() => expect(h.post).toHaveBeenCalledWith("/api/v1/channels/bot", { token: "123456789:AAH-um-token-bem-comprido" }));
  await waitFor(() => expect(campo.value).toBe(""));
});

it("conectado: mostra o robô e desconecta pela exclusão neutra da conexão", async () => {
  h.get.mockResolvedValue({
    data: { ...desconectado, connected: true, channel_session_id: "sess-1", display_name: "Acme", status: "WORKING", has_token: true },
  });
  h.remove.mockResolvedValue({ data: { id: "sess-1" } });
  mount();
  expect((await screen.findByTestId("canal-bot-nome")).textContent).toBe("Acme");

  fireEvent.click(screen.getByRole("button", { name: "Desconectar" }));
  await waitFor(() => expect(h.remove).toHaveBeenCalledWith("/api/v1/channel-sessions/sess-1"));
});
