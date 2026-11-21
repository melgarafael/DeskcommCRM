import { beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/types";
import { CanalChatClient } from "./CanalChatClient";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: h.get, post: h.post, patch: h.patch, delete: vi.fn() } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const ROTA = "/api/v1/channels/webchat";
const CHAVE = "wck_chave-de-teste_1234567890";

const semConexao = {
  connected: false,
  id: null,
  display_name: null,
  status: null,
  public_key: null,
  allowed_origins: [],
  config: {},
};

const comConexao = {
  connected: true,
  id: "conexao-1",
  display_name: "Chat no site",
  status: "WORKING",
  public_key: CHAVE,
  allowed_origins: ["https://loja.exemplo.com.br"],
  config: { titulo: "Fale conosco", coleta: { nome: "opcional", telefone: "opcional", email: "oculto" } },
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CanalChatClient />
    </QueryClientProvider>,
  );
}

it("sem conexão: mostra 'Ativar chat no site' e manda os domínios aparados, sem linha vazia", async () => {
  h.get.mockResolvedValue({ data: semConexao });
  h.post.mockResolvedValue({ data: { id: "conexao-1", public_key: CHAVE, allowed_origins: [] } });
  mount();
  await screen.findByText("Não conectado");

  const dominios = screen.getByLabelText("Domínios, um por linha") as HTMLTextAreaElement;
  fireEvent.change(dominios, { target: { value: "  https://a.exemplo.com.br \n\n https://b.exemplo.com.br  \n" } });
  fireEvent.click(screen.getByRole("button", { name: "Ativar chat no site" }));

  await waitFor(() =>
    expect(h.post).toHaveBeenCalledWith(ROTA, {
      allowed_origins: ["https://a.exemplo.com.br", "https://b.exemplo.com.br"],
    }),
  );
});

it("sem domínios, o aviso diz que o chat só abre pelo link direto", async () => {
  h.get.mockResolvedValue({ data: semConexao });
  mount();
  await screen.findByText("Não conectado");
  expect(screen.getByText(/só abre pelo link direto/)).toBeTruthy();
});

it("com conexão: mostra o código para colar com a chave e a origem desta página", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  mount();
  const codigo = (await screen.findByLabelText("Código para colar no site")) as HTMLTextAreaElement;
  expect(codigo.value).toBe(
    `<script src="${window.location.origin}/webchat.js?k=${CHAVE}" async></script>`,
  );
  expect(codigo.readOnly).toBe(true);
  expect((screen.getByLabelText("Link direto") as HTMLInputElement).value).toBe(
    `${window.location.origin}/chat/${CHAVE}`,
  );
});

it("copiar sem permissão do navegador avisa em vez de falhar em silêncio", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  mount();
  await screen.findByLabelText("Código para colar no site");
  fireEvent.click(screen.getAllByRole("button", { name: "Copiar código" })[0]);
  await waitFor(() => expect(toast.error).toHaveBeenCalled());
});

it("gerar nova chave pede confirmação antes de chamar o giro", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.post.mockResolvedValue({ data: { id: "conexao-1", public_key: "wck_nova" } });
  mount();
  await screen.findByLabelText("Código para colar no site");

  fireEvent.click(screen.getByRole("button", { name: "Gerar nova chave" }));
  const dialogo = await screen.findByRole("alertdialog");
  expect(within(dialogo).getByText(/deixam de abrir conversas novas/)).toBeTruthy();
  expect(h.post).not.toHaveBeenCalled();

  fireEvent.click(within(dialogo).getByRole("button", { name: "Sim, gerar nova chave" }));
  await waitFor(() => expect(h.post).toHaveBeenCalledWith(`${ROTA}/girar`, {}));
});

it("salvar aparência manda só o título preenchido — campo em branco não muda", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Título");

  fireEvent.change(screen.getByLabelText("Título"), { target: { value: "  Olá, posso ajudar?  " } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar aparência" }));

  await waitFor(() => expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { titulo: "Olá, posso ajudar?" } }));
});

it("salvar coleta leva a coleta inteira, porque o servidor troca o objeto de uma vez", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  const nome = (await screen.findByLabelText("Nome")) as HTMLSelectElement;

  fireEvent.change(nome, { target: { value: "obrigatorio" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar coleta" }));

  await waitFor(() =>
    expect(h.patch).toHaveBeenCalledWith(ROTA, {
      config: { coleta: { nome: "obrigatorio", telefone: "opcional", email: "oculto" } },
    }),
  );
});

it("salvar domínios manda só a lista; cor fora do formato #rrggbb não sai", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Cor");

  fireEvent.change(screen.getByLabelText("Cor"), { target: { value: "azul" } });
  expect((screen.getByRole("button", { name: "Salvar aparência" }) as HTMLButtonElement).disabled).toBe(true);

  const dominios = screen.getByLabelText("Domínios, um por linha");
  fireEvent.change(dominios, { target: { value: "https://loja.exemplo.com.br\nhttps://outra.exemplo.com.br" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar domínios" }));
  await waitFor(() =>
    expect(h.patch).toHaveBeenCalledWith(ROTA, {
      allowed_origins: ["https://loja.exemplo.com.br", "https://outra.exemplo.com.br"],
    }),
  );
});

it("erro 422 do servidor aparece no aviso com a mensagem dele", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockRejectedValue(
    new ApiError(422, "invalid_request", undefined, "req-1", "Confira os domínios e a configuração do chat."),
  );
  mount();
  await screen.findByLabelText("Título");

  fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Oi" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar aparência" }));

  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("Confira os domínios e a configuração do chat."),
  );
});
