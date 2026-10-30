import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Os DOIS modos do composer (#1863, F3).
 *
 * O que está em disputa aqui não é "abre o preview" — é para ONDE o arquivo
 * vai. Um anexo escolhido em "Nota interna" que caia no caminho de mensagem
 * sobe em `whatsapp-media` e chega no celular do cliente: o defeito é
 * irreversível assim que sai, não tem rollback, e um dropdown de dois botões é
 * a única coisa entre um print interno e a pessoa.
 *
 * Por isso os mocks são separados (`sendMock` × `createNoteMock`) e cada caso
 * fecha com o `not.toHaveBeenCalled()` do caminho oposto: provar que um caminho
 * foi usado NÃO prova que o outro não foi.
 */

const sendMock = vi.fn();
const createNoteMock = vi.fn();
const uploadMock = vi.fn();

const UPLOAD_DE_NOTA = {
  storage_path: "org-1/conv-1/note-abc.png",
  media_mime: "image/png",
  media_size_bytes: 3,
  kind: "image" as const,
};

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: createNoteMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  // Sem grupo (#3245): a barra e o slash-menu são os de antes dos grupos.
  useGruposDeRespostas: () => ({ data: [] }),
  useMessageTemplates: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { Composer } from "@/components/inbox/Composer";

function renderComposer() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
}

/** Abre o menu "+" e escolhe um arquivo — o caminho que o operador usa. */
async function escolherArquivo(nome: string, tipo: string) {
  fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
  const input = document.querySelector('input[accept^="image"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], nome, { type: tipo });
  fireEvent.change(input, { target: { files: [file] } });
  return await screen.findByRole("dialog");
}

describe("Composer + modo nota interna", () => {
  beforeEach(() => {
    sendMock.mockClear();
    createNoteMock.mockClear();
    uploadMock.mockClear();
    uploadMock.mockResolvedValue(UPLOAD_DE_NOTA);
  });

  it("modo reply (default): envia normal via useSendMessage", () => {
    renderComposer();
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "oi cliente" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "conv-1", body: "oi cliente", type: "text" }),
      expect.anything(),
    );
    expect(createNoteMock).not.toHaveBeenCalled();
  });

  it("limpa o input na hora do envio, sem esperar onSuccess da API", () => {
    sendMock.mockImplementation(() => {
      /* simula request lento — onSuccess não é chamado */
    });
    renderComposer();
    const input = screen.getByLabelText(/mensagem/i);
    fireEvent.change(input, { target: { value: "oi cliente" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(input).toHaveValue("");
  });

  it("alterna pra modo nota interna: some rascunho/áudio, muda placeholder — e o ANEXO FICA", () => {
    renderComposer();
    expect(screen.getByRole("button", { name: /anexar/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sugerir resposta/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));

    // F3 (#1863): o "+" deixou de ser exclusivo da resposta — a nota passou a
    // aceitar anexo. O que continua sumindo é o que sairia para o cliente:
    // rascunho sugerido (é uma mensagem) e áudio (grava mensagem).
    expect(screen.getByRole("button", { name: /anexar/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sugerir resposta/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /gravar áudio/i })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/nota interna/i)).toBeInTheDocument();
  });

  it("modo nota interna: enviar chama useCreateNote e NÃO useSendMessage", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));

    fireEvent.change(screen.getByPlaceholderText(/nota interna/i), { target: { value: "cliente ligou reclamando" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "conv-1", body: "cliente ligou reclamando" }),
      expect.anything(),
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ANEXO em modo NOTA: upload em notes/media + useCreateNote — e NÃO vai para o cliente", async () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
    const dialog = await escolherArquivo("print.png", "image/png");

    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));

    await waitFor(() =>
      expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-1", destino: "nota" })),
    );
    await waitFor(() =>
      expect(createNoteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation_id: "conv-1",
          body: "",
          anexo: {
            storage_path: "org-1/conv-1/note-abc.png",
            media_mime: "image/png",
            media_size_bytes: 3,
          },
        }),
        expect.anything(),
      ),
    );
    // A asserção que importa: nada saiu pelo caminho de mensagem.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ANEXO em modo REPLY: upload em media + useSendMessage — o comportamento de antes", async () => {
    renderComposer();
    const dialog = await escolherArquivo("foto.jpg", "image/jpeg");
    fireEvent.change(within(dialog).getByLabelText(/legenda/i), { target: { value: "olha isso" } });

    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));

    await waitFor(() =>
      expect(uploadMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: "conv-1", destino: "mensagem" }),
      ),
    );
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation_id: "conv-1",
          type: "image",
          body: "olha isso",
          media_storage_path: "org-1/conv-1/note-abc.png",
        }),
        expect.anything(),
      ),
    );
    expect(createNoteMock).not.toHaveBeenCalled();
  });

  it("escolhido em NOTA e enviado depois em REPLY: continua nota — o destino é o da ESCOLHA", async () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
    const dialog = await escolherArquivo("print.png", "image/png");

    // O operador troca de modo com o diálogo aberto. No app o modal bloqueia o
    // clique (overlay com pointer-events), então este caso é a garantia de
    // CÓDIGO, não de tela: se o overlay mudar, o destino não acompanha o modo
    // de agora — acompanha o modo em que o arquivo entrou. O clique vai pelo
    // DOM porque o Radix põe o resto da tela em `aria-hidden` com o dialog
    // aberto, e `getByRole` respeita isso.
    const botaoResponder = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Responder",
    );
    expect(botaoResponder, "o toggle Responder existe, escondido pelo modal").toBeTruthy();
    fireEvent.click(botaoResponder!);

    fireEvent.click(within(dialog).getByRole("button", { name: /^enviar$/i }));

    await waitFor(() => expect(createNoteMock).toHaveBeenCalled());
    expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv-1", destino: "nota" }));
    expect(sendMock).not.toHaveBeenCalled();
  });
});
