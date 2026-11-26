import { beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/types";
import { makeQueryClient } from "@/lib/query/client";
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
  h.get.mockReset();
  h.post.mockReset();
  h.patch.mockReset();
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
  await screen.findByRole("button", { name: "Ativar chat no site" });

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
  await screen.findByRole("button", { name: "Ativar chat no site" });
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
  fireEvent.click(screen.getAllByRole("button", { name: "Copiar código" })[0]!);
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

it("salvar teto_anonimo manda o número para o servidor; fora de 1 a 200 não envia", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Quantas respostas da IA por conversa");

  const teto = screen.getByLabelText("Quantas respostas da IA por conversa") as HTMLInputElement;

  // Valor válido: digita 5 e salva.
  fireEvent.change(teto, { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar teto" }));
  await waitFor(() =>
    expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { teto_anonimo: 5 } }),
  );

  // Valor inválido: não envia e mostra erro.
  fireEvent.change(teto, { target: { value: "201" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar teto" }));
  expect(screen.getByText(/Use um número inteiro de 1 a 200./)).toBeTruthy();
  expect(h.patch).not.toHaveBeenCalledWith(ROTA, { config: { teto_anonimo: 201 } });
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

it("copiar com sucesso põe o código exato na área de transferência e avisa", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  mount();
  await screen.findByLabelText("Código para colar no site");

  fireEvent.click(screen.getByRole("button", { name: "Copiar código" }));

  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(`<script src="${window.location.origin}/webchat.js?k=${CHAVE}" async></script>`),
  );
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Copiado."));
});

it("falha ao carregar mostra o alerta de erro no lugar da tela", async () => {
  h.get.mockRejectedValue(new Error("rede caiu"));
  mount();
  const alerta = await screen.findByRole("alert");
  expect(alerta.textContent).toBe("Não foi possível carregar o chat no site. Recarregue a página.");
});

it("falha ao gerar a chave mantém o diálogo aberto e avisa", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.post.mockRejectedValue(new Error("falhou"));
  mount();
  await screen.findByLabelText("Código para colar no site");

  fireEvent.click(screen.getByRole("button", { name: "Gerar nova chave" }));
  const dialogo = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialogo).getByRole("button", { name: "Sim, gerar nova chave" }));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível gerar a chave. Tente de novo."));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

it("mais de 20 domínios mostra o limite e não envia", async () => {
  h.get.mockResolvedValue({ data: semConexao });
  mount();
  await screen.findByRole("button", { name: "Ativar chat no site" });

  const linhas = Array.from({ length: 21 }, (_, i) => `https://site${i}.exemplo.com.br`).join("\n");
  fireEvent.change(screen.getByLabelText("Domínios, um por linha"), { target: { value: linhas } });

  expect(screen.getByText("Use até 20 domínios.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Ativar chat no site" }) as HTMLButtonElement).disabled).toBe(true);
  expect(h.post).not.toHaveBeenCalled();
});

it("depois de salvar, os domínios voltam como o servidor guardou (sem duplicata) e o botão desabilita", async () => {
  const guardado = ["https://loja.exemplo.com.br", "https://outra.exemplo.com.br"];
  h.get
    .mockResolvedValueOnce({ data: comConexao })
    .mockResolvedValue({ data: { ...comConexao, allowed_origins: guardado } });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  const dominios = (await screen.findByLabelText("Domínios, um por linha")) as HTMLTextAreaElement;

  fireEvent.change(dominios, {
    target: { value: "https://loja.exemplo.com.br\nhttps://outra.exemplo.com.br\nHTTPS://OUTRA.exemplo.com.br" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Salvar domínios" }));

  await waitFor(() => expect(dominios.value).toBe("https://loja.exemplo.com.br\nhttps://outra.exemplo.com.br"));
  expect((screen.getByRole("button", { name: "Salvar domínios" }) as HTMLButtonElement).disabled).toBe(true);
});

it("pausar o chat pede confirmação antes do PATCH e só então manda pausado true", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByRole("button", { name: "Pausar o chat" });
  expect(screen.queryByText("Pausado")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Pausar o chat" }));
  const dialogo = await screen.findByRole("alertdialog");
  expect(within(dialogo).getByText(/chat indisponível/)).toBeTruthy();
  expect(h.patch).not.toHaveBeenCalled();

  fireEvent.click(within(dialogo).getByRole("button", { name: "Sim, pausar o chat" }));
  await waitFor(() => expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { pausado: true } }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Chat pausado. A janela não abre até você retomar."));
});

it("com o chat pausado, mostra o Badge Pausado e retomar não pede confirmação", async () => {
  h.get.mockResolvedValue({ data: { ...comConexao, config: { ...comConexao.config, pausado: true } } });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  expect(await screen.findByText("Pausado")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Retomar o chat" }));
  await waitFor(() => expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { pausado: false } }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Chat retomado. A janela volta a abrir no seu site."));
});

it("T6 (a): digitar domínios enquanto o PATCH está pendente mantém o que foi digitado", async () => {
  // A 1ª leitura é a da montagem; as seguintes (o refetch depois de salvar) trazem o que o servidor guardou.
  const guardadoNoServidor = { ...comConexao, allowed_origins: ["https://servidor.exemplo.com.br"] };
  h.get.mockResolvedValueOnce({ data: comConexao }).mockResolvedValue({ data: guardadoNoServidor });
  let resolverPatch!: (valor: unknown) => void;
  h.patch.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolverPatch = resolve;
      }),
  );
  mount();
  const dominios = (await screen.findByLabelText("Domínios, um por linha")) as HTMLTextAreaElement;

  fireEvent.change(dominios, { target: { value: "https://nova.exemplo.com.br" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar domínios" }));
  await waitFor(() =>
    expect(h.patch).toHaveBeenCalledWith(ROTA, { allowed_origins: ["https://nova.exemplo.com.br"] }),
  );

  // O PATCH ainda está pendente: o usuário altera o campo de novo.
  fireEvent.change(dominios, { target: { value: "https://outra.exemplo.com.br" } });

  // O servidor responde; o componente relê a conexão (2ª chamada ao GET) e devolve a lista guardada.
  resolverPatch({ data: { id: "conexao-1" } });
  await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Alterações salvas."));
  await new Promise((r) => setTimeout(r, 20));

  // Sem a correção, o campo voltaria para "https://servidor.exemplo.com.br".
  expect(dominios.value).toBe("https://outra.exemplo.com.br");
});

it("T6 (b): PATCH ok e refetch falha → 'Alterações salvas.' sem toast de erro", async () => {
  // A 1ª leitura (montagem) funciona; o refetch depois de salvar é que falha.
  h.get.mockResolvedValueOnce({ data: comConexao }).mockRejectedValue(new Error("rede caiu"));
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Título");

  fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Novo título" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar aparência" }));

  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Alterações salvas."));
  await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
  await new Promise((r) => setTimeout(r, 20));
  // O PATCH deu certo; só a releitura falhou: não é erro de salvar.
  expect(toast.error).not.toHaveBeenCalled();
});

it("com o cache do app (30 s), gerar nova chave troca o código na tela sem recarregar a página", async () => {
  // O cliente do app considera a leitura fresca por 30 s. Com o cliente padrão do teste (0 s) o
  // defeito não aparece: o recarregar devolvia o cache e a tela seguia com a chave ANTIGA.
  h.get.mockResolvedValueOnce({ data: comConexao }).mockResolvedValue({ data: { ...comConexao, public_key: "wck_nova" } });
  h.post.mockResolvedValue({ data: { id: "conexao-1", public_key: "wck_nova" } });
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <CanalChatClient />
    </QueryClientProvider>,
  );
  const codigo = (await screen.findByLabelText("Código para colar no site")) as HTMLTextAreaElement;
  expect(codigo.value).toContain(CHAVE);

  fireEvent.click(screen.getByRole("button", { name: "Gerar nova chave" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Sim, gerar nova chave" }));

  await waitFor(() => expect((screen.getByLabelText("Código para colar no site") as HTMLTextAreaElement).value).toContain("wck_nova"));
  expect(h.get).toHaveBeenCalledTimes(2);
});

it("salvar formato e posicao manda o PATCH com ambos os valores", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Formato");

  const formato = screen.getByLabelText("Formato") as HTMLSelectElement;
  const posicao = screen.getByLabelText("Posição") as HTMLSelectElement;

  fireEvent.change(formato, { target: { value: "painel" } });
  fireEvent.change(posicao, { target: { value: "esquerda" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar formato" }));

  await waitFor(() =>
    expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { formato: "painel" } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Salvar posição" }));
  await waitFor(() =>
    expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { posicao: "esquerda" } }),
  );
});

it("salvar formato e salvar posição só ligam quando algo mudou", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  mount();
  await screen.findByLabelText("Formato");

  const salvarFormato = screen.getByRole("button", { name: "Salvar formato" }) as HTMLButtonElement;
  const salvarPosicao = screen.getByRole("button", { name: "Salvar posição" }) as HTMLButtonElement;
  expect(salvarFormato.disabled).toBe(true);
  expect(salvarPosicao.disabled).toBe(true);

  fireEvent.change(screen.getByLabelText("Formato"), { target: { value: "embutido" } });
  expect(salvarFormato.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Formato"), { target: { value: "bolha" } });
  expect(salvarFormato.disabled).toBe(true);

  fireEvent.change(screen.getByLabelText("Posição"), { target: { value: "esquerda" } });
  expect(salvarPosicao.disabled).toBe(false);
  fireEvent.click(salvarPosicao);
  await waitFor(() => expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { posicao: "esquerda" } }));
});

it("codigo para colar mostra o formato e posicao salvos", async () => {
  h.get.mockResolvedValue({
    data: {
      ...comConexao,
      config: { ...comConexao.config, formato: "painel", posicao: "esquerda" },
    },
  });
  mount();
  const codigo = (await screen.findByLabelText("Código para colar no site")) as HTMLTextAreaElement;
  expect(codigo.value).toContain("&f=painel");
  expect(codigo.value).toContain("&p=esquerda");
});

it("ajustes da janela aparecem com os valores da configuracao", async () => {
  h.get.mockResolvedValue({
    data: {
      ...comConexao,
      config: {
        ...comConexao.config,
        avatar_url: "https://example.com/avatar.png",
        auto_abrir_segundos: 30,
        som: true,
        respostas_rapidas: ["Sim", "Nao"],
      },
    },
  });
  mount();
  await screen.findByLabelText("Avatar");

  const avatar = screen.getByLabelText("Avatar") as HTMLInputElement;
  expect(avatar.value).toBe("https://example.com/avatar.png");

  const autoAbrir = screen.getByLabelText("Abrir sozinho após (segundos)") as HTMLInputElement;
  expect(autoAbrir.value).toBe("30");

  const som = screen.getByLabelText("Tocar som ao chegar resposta") as HTMLInputElement;
  expect(som.checked).toBe(true);

  const respostas = screen.getByLabelText("Respostas rápidas do chat") as HTMLTextAreaElement;
  expect(respostas.value).toBe("Sim\nNao");
});

it("salvar ajustes manda os campos preenchidos pelo PATCH", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Avatar");

  fireEvent.change(screen.getByLabelText("Avatar"), { target: { value: "https://example.com/novo.png" } });
  fireEvent.change(screen.getByLabelText("Abrir sozinho após (segundos)"), { target: { value: "45" } });
  fireEvent.click(screen.getByLabelText("Tocar som ao chegar resposta"));
  fireEvent.change(screen.getByLabelText("Respostas rápidas do chat"), { target: { value: "Oi\nTchau" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar ajustes" }));

  await waitFor(() =>
    expect(h.patch).toHaveBeenCalledWith(ROTA, {
      config: {
        avatar_url: "https://example.com/novo.png",
        auto_abrir_segundos: 45,
        som: true,
        respostas_rapidas: ["Oi", "Tchau"],
      },
    }),
  );
});

it("mudar so o som manda apenas som", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Avatar");

  fireEvent.click(screen.getByLabelText("Tocar som ao chegar resposta"));
  fireEvent.click(screen.getByRole("button", { name: "Salvar ajustes" }));

  await waitFor(() => expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { som: true } }));
});

it("auto-abrir em branco desliga e envia 0", async () => {
  h.get.mockResolvedValue({
    data: { ...comConexao, config: { ...comConexao.config, auto_abrir_segundos: 30 } },
  });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Abrir sozinho após (segundos)");

  fireEvent.change(screen.getByLabelText("Abrir sozinho após (segundos)"), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Salvar ajustes" }));

  await waitFor(() =>
    expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { auto_abrir_segundos: 0 } }),
  );
});

it("auto-abrir ausente e campo em branco nao liga o botao salvar ajustes", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Abrir sozinho após (segundos)");

  fireEvent.change(screen.getByLabelText("Abrir sozinho após (segundos)"), {
    target: { value: "" },
  });

  expect(
    (screen.getByRole("button", { name: "Salvar ajustes" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(h.patch).not.toHaveBeenCalled();
});

it("avatar invalido mostra erro em portugues e nao envia", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Avatar");

  fireEvent.change(screen.getByLabelText("Avatar"), { target: { value: "http://inseguro.com/a.png" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar ajustes" }));

  expect(screen.getByText("Use https:// na URL do avatar.")).toBeTruthy();
  expect(h.patch).not.toHaveBeenCalled();
});

it("auto_abrir_segundos invalido mostra erro e nao envia", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Abrir sozinho após (segundos)");

  fireEvent.change(screen.getByLabelText("Abrir sozinho após (segundos)"), { target: { value: "121" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar ajustes" }));

  expect(screen.getByText("Use um número inteiro de 0 a 120 segundos.")).toBeTruthy();
  expect(h.patch).not.toHaveBeenCalled();
});

it("mais de 5 respostas rapidas mostra erro e nao envia", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Respostas rápidas do chat");

  fireEvent.change(screen.getByLabelText("Respostas rápidas do chat"), {
    target: { value: ["1", "2", "3", "4", "5", "6"].join("\n") },
  });
  fireEvent.click(screen.getByRole("button", { name: "Salvar ajustes" }));

  expect(screen.getByText("Use até 5 respostas rápidas, de 1 a 80 caracteres cada.")).toBeTruthy();
  expect(h.patch).not.toHaveBeenCalled();
});

it("apagar respostas rapidas envia array vazio", async () => {
  h.get.mockResolvedValue({
    data: { ...comConexao, config: { ...comConexao.config, respostas_rapidas: ["Sim"] } },
  });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Respostas rápidas do chat");

  fireEvent.change(screen.getByLabelText("Respostas rápidas do chat"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar ajustes" }));

  await waitFor(() =>
    expect(h.patch).toHaveBeenCalledWith(ROTA, {
      config: { respostas_rapidas: [] },
    }),
  );
});

it("salvar ajustes so liga quando algo mudou", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  mount();
  await screen.findByLabelText("Avatar");

  const salvar = screen.getByRole("button", { name: "Salvar ajustes" }) as HTMLButtonElement;
  expect(salvar.disabled).toBe(true);

  fireEvent.change(screen.getByLabelText("Avatar"), { target: { value: "https://example.com/a.png" } });
  expect(salvar.disabled).toBe(false);

  fireEvent.change(screen.getByLabelText("Avatar"), { target: { value: "" } });
  expect(salvar.disabled).toBe(true);
});

it("som desmarcado e marcado volta ao estado inicial desliga o botao", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  mount();
  await screen.findByLabelText("Tocar som ao chegar resposta");

  const salvar = screen.getByRole("button", { name: "Salvar ajustes" }) as HTMLButtonElement;
  expect(salvar.disabled).toBe(true);

  fireEvent.click(screen.getByLabelText("Tocar som ao chegar resposta"));
  expect(salvar.disabled).toBe(false);

  fireEvent.click(screen.getByLabelText("Tocar som ao chegar resposta"));
  expect(salvar.disabled).toBe(true);
});

it("depois de salvar o som, a caixinha mostra o que o servidor guardou e o botão desliga", async () => {
  h.get
    .mockResolvedValueOnce({ data: comConexao })
    .mockResolvedValue({ data: { ...comConexao, config: { ...comConexao.config, som: true } } });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Tocar som ao chegar resposta");

  fireEvent.click(screen.getByLabelText("Tocar som ao chegar resposta"));
  fireEvent.click(screen.getByRole("button", { name: "Salvar ajustes" }));
  await waitFor(() => expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { som: true } }));
  await waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(toast.success).toHaveBeenCalled());

  const som = screen.getByLabelText("Tocar som ao chegar resposta") as HTMLInputElement;
  await waitFor(() => expect(som.checked).toBe(true));
  expect((screen.getByRole("button", { name: "Salvar ajustes" }) as HTMLButtonElement).disabled).toBe(true);
});

it("apagar o avatar manda avatar_url vazio, e não um PATCH vazio que diz 'salvo'", async () => {
  h.get.mockResolvedValue({
    data: { ...comConexao, config: { ...comConexao.config, avatar_url: "https://example.com/a.png" } },
  });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  await screen.findByLabelText("Avatar");

  fireEvent.change(screen.getByLabelText("Avatar"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar ajustes" }));
  await waitFor(() => expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { avatar_url: "" } }));
});

it("teto_anonimo aceita 150 (entre 100 e 200) e em branco não envia nada", async () => {
  h.get.mockResolvedValue({ data: comConexao });
  h.patch.mockResolvedValue({ data: { id: "conexao-1" } });
  mount();
  const teto = (await screen.findByLabelText("Quantas respostas da IA por conversa")) as HTMLInputElement;

  // Nunca salvo e em branco: o botão está desligado (vale o padrão 20, nada a enviar).
  expect(teto.value).toBe("");
  expect((screen.getByRole("button", { name: "Salvar teto" }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.change(teto, { target: { value: "150" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar teto" }));
  await waitFor(() =>
    expect(h.patch).toHaveBeenCalledWith(ROTA, { config: { teto_anonimo: 150 } }),
  );
});
