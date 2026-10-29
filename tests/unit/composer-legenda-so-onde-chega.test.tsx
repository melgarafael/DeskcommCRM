/**
 * O COMPOSITOR MANDA A LEGENDA SÓ COM O ANEXO QUE A LEVA (#3151).
 *
 * O teste do diálogo (`AttachmentPreviewDialog.test.tsx`) prova o CAMPO; este
 * prova as três decisões do `Composer.tsx`, que nenhum outro teste exercita —
 * o único teste de compositor com áudio (`composer-recursos-pre-prontos`) usa
 * um recurso de áudio de corpo VAZIO, e não passa por nenhum dos ramos novos.
 *
 *   (a) resposta rápida SÓ DE ÁUDIO com corpo: o texto fica no CAMPO, o diálogo
 *       abre sem "Legenda" e o áudio sai com `body` undefined.
 *   (b) fila [áudio, imagem]: o texto viaja com a IMAGEM, não com o índice 0.
 *       É o caso que fica vermelho se `indice === indiceLegenda` voltar a ser
 *       `indice === 0`.
 *   (c) fila [imagem, áudio], tirando a imagem: o que sobra não leva legenda,
 *       então o texto volta ao campo e o diálogo segue aberto com o áudio.
 *
 * O envio (`useSendMessage`) é um espião que chama o `onSuccess`, para a fila
 * andar como anda em produção (a recursão do `enviarAnexos` entra por ali).
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const uploadMock = vi.fn();
const getMock = vi.fn();
const fetchMock = vi.fn();

const ORG = "11111111-1111-4111-8111-111111111111";
const SO_AUDIO_ID = "dddddddd-1111-4111-8111-111111111111";
const AUDIO_IMAGEM_ID = "eeeeeeee-2222-4222-8222-222222222222";
const IMAGEM_AUDIO_ID = "ffffffff-3333-4333-8333-333333333333";

const audio = (id: string) => ({
  storage_path: `${ORG}/templates/${id}/0a0b0c0d-0000-4000-8000-00000000000a.ogg`,
  media_mime: "audio/ogg",
  media_size_bytes: 1234,
});
const imagem = (id: string) => ({
  storage_path: `${ORG}/templates/${id}/0a0b0c0d-0000-4000-8000-00000000000b.jpg`,
  media_mime: "image/jpeg",
  media_size_bytes: 4321,
});

const RECURSOS = [
  {
    id: SO_AUDIO_ID,
    title: "Áudio com recado",
    body: "Ouve o áudio, {{primeiro_nome}}",
    shortcut: null,
    owner_user_id: null,
    midias: [audio(SO_AUDIO_ID)],
  },
  {
    id: AUDIO_IMAGEM_ID,
    title: "Áudio e tabela",
    body: "Segue a tabela",
    shortcut: null,
    owner_user_id: null,
    midias: [audio(AUDIO_IMAGEM_ID), imagem(AUDIO_IMAGEM_ID)],
  },
  {
    id: IMAGEM_AUDIO_ID,
    title: "Tabela e áudio",
    body: "Olha a tabela",
    shortcut: null,
    owner_user_id: null,
    midias: [imagem(IMAGEM_AUDIO_ID), audio(IMAGEM_AUDIO_ID)],
  },
];

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: RECURSOS, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: vi.fn(),
    get: (...args: unknown[]) => getMock(...args) as Promise<unknown>,
  },
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  // A escolha de contato do Composer lê o país da organização (o exemplo do telefone); sem organização, o Brasil.
  usePaisDaOrgAtiva: () => null,
}));

import { Composer } from "@/components/inbox/Composer";

const CONV = "aaaaaaaa-3333-4000-8000-000000000001";

function renderComposer() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId={CONV} contactName="Ana" />
    </QueryClientProvider>,
  );
}

/** O que cada `send.mutate` levou, na ordem: o tipo do anexo e o `body`. */
function enviados() {
  return sendMock.mock.calls.map(([dados]) => {
    const { type, body } = dados as { type: string; body?: string };
    return { type, body };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue({ data: [], meta: { has_more: false } });
  fetchMock.mockResolvedValue({
    ok: true,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  uploadMock.mockImplementation(async ({ file }: { file: File }) => ({
    kind: file.type.startsWith("audio/") ? "audio" : "image",
    storage_path: `${ORG}/conv/${file.name}`,
    media_mime: file.type,
    media_size_bytes: file.size,
  }));
  sendMock.mockImplementation((_dados: unknown, opcoes?: { onSuccess?: () => void }) => {
    opcoes?.onSuccess?.();
  });
});

describe("Composer: a legenda vai só com o anexo que a leva (#3151)", () => {
  it("(a) resposta rápida SÓ DE ÁUDIO: o corpo fica no campo e o áudio sai sem texto", async () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /áudio com recado/i }));

    const fila = await screen.findByRole("dialog");
    expect(within(fila).queryByLabelText("Legenda")).toBeNull();
    expect(screen.getByLabelText(/mensagem/i)).toHaveValue("Ouve o áudio, Ana");

    await act(async () => {
      fireEvent.click(within(fila).getByRole("button", { name: "Enviar" }));
    });

    expect(enviados()).toEqual([{ type: "audio", body: undefined }]);
  });

  it("(b) fila [áudio, imagem]: o texto viaja com a IMAGEM, não com o primeiro da fila", async () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /áudio e tabela/i }));

    const fila = await screen.findByRole("dialog");
    expect(within(fila).getByLabelText("Legenda")).toHaveValue("Segue a tabela");

    await act(async () => {
      fireEvent.click(within(fila).getByRole("button", { name: "Enviar" }));
    });

    expect(enviados()).toEqual([
      { type: "audio", body: undefined },
      { type: "image", body: "Segue a tabela" },
    ]);
  });

  it("(c) fila [imagem, áudio] sem a imagem: o texto volta ao campo e o diálogo segue com o áudio", async () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /tabela e áudio/i }));

    const fila = await screen.findByRole("dialog");
    expect(within(fila).getByLabelText("Legenda")).toHaveValue("Olha a tabela");
    expect(screen.getByLabelText(/mensagem/i)).toHaveValue("");

    // O primeiro "remover" é o da capa, que aqui é a imagem.
    const [removerCapa] = within(fila).getAllByRole("button", { name: "Remover imagem" });
    if (!removerCapa) throw new Error("o diálogo não mostrou o botão de remover a capa");
    fireEvent.click(removerCapa);
    await act(async () => {
      await new Promise((pronto) => requestAnimationFrame(() => pronto(null)));
    });

    const campo = screen.getByLabelText(/mensagem/i);
    expect(campo).toHaveValue("Olha a tabela");
    expect(campo).not.toHaveFocus();
    const restante = screen.getByRole("dialog");
    expect(within(restante).queryByLabelText("Legenda")).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
