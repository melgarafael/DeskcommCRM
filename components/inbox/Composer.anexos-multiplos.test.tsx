/**
 * #4364 — vários anexos pelo botão "+" caem na MESMA fila da prévia.
 *
 * O conserto do menu não pode inventar um segundo caminho de envio: o pedido é
 * que o "+" entregue a LISTA na função que o arraste já usa (`escolherArquivos`),
 * com prévia, limite de tamanho e retry iguais. O dublê da prévia é o ponto de
 * medição: o que chega nela é a fila que o compositor montou, e o `onSend` dela
 * é o `enviarAnexos` de verdade — o upload sai por aqui, um arquivo por vez,
 * na ordem da escolha.
 *
 * Diferente de `Composer.arraste-de-arquivo.test.tsx`, o `AttachMenu` aqui é o
 * REAL (com os inputs e o popover): o defeito morava nele, e um dublê do menu
 * provaria o compositor contra o contrato que o teste escreveu.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type ComponentProps } from "react";

const deps = vi.hoisted(() => ({
  uploadMutateAsync: vi.fn(),
  sendMutate: vi.fn(),
  noteMutate: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: deps.sendMutate, mutateAsync: deps.sendMutate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: deps.noteMutate, mutateAsync: deps.noteMutate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: deps.uploadMutateAsync, isPending: false }),
}));
vi.mock("@/hooks/inbox/useRascunhoAssistido", () => ({
  useRascunhoAssistido: () => ({ sugestao: undefined, invalidar: () => {} }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useGruposDeRespostas: () => ({ data: [] }),
  useMessageTemplates: () => ({ data: [] }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/inbox/clipboard-image", () => ({ imagemDoClipboard: vi.fn(() => null) }));
vi.mock("@/lib/notifications/mentions", () => ({
  embutirMencoes: vi.fn((body: string) => body),
  podarMencoesDaEdicao: vi.fn((_antes: string, _depois: string, m: unknown) => m),
  podarMencoes: vi.fn((_texto: string, m: unknown) => m),
  resolverMencao: vi.fn(() => null),
}));
vi.mock("@/lib/messaging/contact-card", () => ({ resolveSharedContact: vi.fn() }));

// O PONTO DE MEDIÇÃO: a fila que chegou à prévia, na ordem, e o envio que ela
// dispara (o `enviarAnexos` real do compositor).
vi.mock("@/components/inbox/composer/AttachmentPreviewDialog", () => ({
  AttachmentPreviewDialog: ({
    files,
    onSend,
  }: {
    files: File[];
    onSend: (caption: string) => void;
  }) => {
    if (!files.length) return null;
    return (
      <div data-testid="previa">
        {files.map((f) => (
          <span key={f.name} data-testid="previa-arquivo">
            {f.name}
          </span>
        ))}
        <button type="button" onClick={() => onSend("")}>
          Enviar anexos
        </button>
      </div>
    );
  },
}));

vi.mock("@/components/inbox/composer/ReplyReviewPanel", () => ({ ReplyReviewPanel: () => null }));
vi.mock("@/components/inbox/composer/DraftReplyButton", () => ({ DraftReplyButton: () => null }));
vi.mock("@/components/inbox/composer/TemplateMenu", () => ({
  resolveSlash: () => ({ open: false, query: "" }),
  TemplateMenu: () => null,
}));
vi.mock("@/components/inbox/composer/MentionMenu", () => ({
  resolverMencao: () => null,
  opcoesDeMencao: () => [],
  MentionMenu: () => null,
}));
vi.mock("@/components/inbox/composer/ContactPickerDialog", () => ({
  ContactPickerDialog: () => null,
}));
vi.mock("@/components/inbox/composer/AudioRecorder", () => ({ AudioRecorder: () => null }));
vi.mock("@/components/inbox/composer/EmojiButton", () => ({ EmojiButton: () => null }));
vi.mock("@/components/inbox/composer/BarraDeRecursos", () => ({ BarraDeRecursos: () => null }));

import { Composer, type ComposerHandle } from "./Composer";

const arquivo = (nome: string) => new File(["conteudo"], nome, { type: "application/pdf" });

/** Escolhe os arquivos pelo menu "+" REAL — popover, opção e input. */
async function escolherPeloMenu(container: HTMLElement, arquivos: File[]) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /anexar/i }));
  await user.click(await screen.findByRole("button", { name: "Documento" }));
  const input = container.querySelector<HTMLInputElement>('input[type="file"][accept*=".pdf"]')!;
  fireEvent.change(input, { target: { files: arquivos } });
}

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  return render(<Composer conversationId="conv-1" contactName="Rafael" {...props} />);
}

beforeEach(() => {
  deps.uploadMutateAsync.mockReset();
  deps.sendMutate.mockReset();
  deps.noteMutate.mockReset();
  deps.uploadMutateAsync.mockResolvedValue({
    storage_path: "conv-1/anexo.pdf",
    media_mime: "application/pdf",
    media_size_bytes: 17,
    kind: "document",
  });
  deps.sendMutate.mockResolvedValue(undefined);
});

describe("o botão + entrega vários anexos na fila do compositor (#4364)", () => {
  it("⭐ dois arquivos escolhidos entram os DOIS na mesma prévia e saem em sequência", async () => {
    const { container } = renderComposer();

    await escolherPeloMenu(container, [arquivo("contrato.pdf"), arquivo("proposta.pdf")]);

    // A MESMA fila do arraste: a prévia recebe a lista inteira, na ordem.
    expect(screen.getAllByTestId("previa-arquivo").map((n) => n.textContent)).toEqual([
      "contrato.pdf",
      "proposta.pdf",
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Enviar anexos" }));
    await waitFor(() => expect(deps.sendMutate).toHaveBeenCalledTimes(2));

    const enviados = deps.uploadMutateAsync.mock.calls.map(
      ([entrada]) => (entrada as { file: File }).file.name,
    );
    expect(enviados).toEqual(["contrato.pdf", "proposta.pdf"]);
  });

  it("controle: UM arquivo pelo menu continua produzindo uma prévia e um envio", async () => {
    const { container } = renderComposer();

    await escolherPeloMenu(container, [arquivo("unico.pdf")]);

    expect(screen.getAllByTestId("previa-arquivo").map((n) => n.textContent)).toEqual([
      "unico.pdf",
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Enviar anexos" }));
    await waitFor(() => expect(deps.sendMutate).toHaveBeenCalledTimes(1));
    expect(deps.uploadMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("continua uma fila confirmada depois de deixar a conversa", async () => {
    let liberar!: () => void;
    const primeiro = new Promise<void>((resolve) => { liberar = resolve; });
    deps.uploadMutateAsync.mockImplementationOnce(async () => {
      await primeiro;
      return { storage_path: "conv-1/primeiro.pdf", media_mime: "application/pdf",
        media_size_bytes: 17, kind: "document" };
    });
    const { container, unmount } = renderComposer();
    await escolherPeloMenu(container, [arquivo("primeiro.pdf"), arquivo("segundo.pdf")]);
    await userEvent.click(screen.getByRole("button", { name: "Enviar anexos" }));
    expect(deps.uploadMutateAsync).toHaveBeenCalledOnce();
    unmount();
    await act(async () => liberar());
    await waitFor(() => expect(deps.sendMutate).toHaveBeenCalledTimes(2));
    expect(deps.sendMutate.mock.calls.map(([dados]) => dados.conversation_id)).toEqual(["conv-1", "conv-1"]);
  });

  it("restaura o anexo ainda não enviado com o destino de nota interna", async () => {
    const ref = createRef<ComposerHandle>();
    const view = renderComposer({ ref });
    await userEvent.click(screen.getByRole("button", { name: "Nota interna" }));
    await escolherPeloMenu(view.container, [arquivo("privado.pdf")]);
    const guardado = ref.current?.guardarRascunho?.();
    expect(guardado).toMatchObject({ modo: "note", modoDosArquivos: "note" });
    view.unmount();
    renderComposer({ rascunhoGuardado: guardado });
    expect(screen.getByTestId("previa-arquivo")).toHaveTextContent("privado.pdf");
    await userEvent.click(screen.getByRole("button", { name: "Enviar anexos" }));
    await waitFor(() => expect(deps.noteMutate).toHaveBeenCalledOnce());
    expect(deps.sendMutate).not.toHaveBeenCalled();
  });

});
