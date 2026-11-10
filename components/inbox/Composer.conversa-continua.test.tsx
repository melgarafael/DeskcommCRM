/**
 * #3732 — A CAIXA DE RESPOSTA TRAVADA COM "ABRIR A CONVERSA".
 *
 * O caso medido: a conversa antiga não pôde seguir o vendedor (o contato já tem
 * conversa no número dele). Ela fica no nome do vendedor, presa num número que
 * não é dele, e o envio recebe 409. Antes, a única coisa na tela era a frase
 * genérica — sem dizer para onde ir; a pessoa ficava com o texto no campo, sem
 * saber que a conversa viva do contato está em outra conversa, no número dela.
 *
 * O que este arquivo segura:
 *
 *  1. a recusa COM destino monta a faixa, diz por qual número a conversa
 *     continua e leva o id da conversa nova — e "Abrir a conversa" chama o
 *     seletor do Inbox;
 *  2. a caixa fica TRAVADA (o campo desabilitado, o Enviar fora do ar) — o
 *     caminho é o `isDisabled` de sempre, não um segundo;
 *  3. CONTROLE: a recusa SEM destino (o detalhe não veio) não monta faixa
 *     nenhuma — a guarda do número continua respondendo como antes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApiError } from "@/lib/api/types";

type Tradutor = (texto: string) => string;

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => ((texto: string) => texto) as Tradutor }));

const { sendMutate, noteMutate, erroDoEnvio } = vi.hoisted(() => ({
  sendMutate: vi.fn(),
  noteMutate: vi.fn(),
  erroDoEnvio: { valor: null as unknown },
}));

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({
    mutate: (entrada: unknown, opcoes?: { onError?: (e: unknown) => void }) => {
      sendMutate(entrada);
      if (erroDoEnvio.valor) opcoes?.onError?.(erroDoEnvio.valor);
    },
    isPending: false,
  }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: noteMutate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useRascunhoAssistido", () => ({
  useRascunhoAssistido: () => ({ sugestao: null, invalidar: () => {} }),
}));
vi.mock("@/components/inbox/composer/DraftReplyButton", () => ({ DraftReplyButton: () => null }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [], isLoading: false }),
  useGruposDeRespostas: () => ({ data: [] }),
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
vi.mock("@/components/inbox/composer/ReplyReviewPanel", () => ({
  ReplyReviewPanel: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="reply-review-panel" data-disabled={String(!!disabled)} />
  ),
}));
vi.mock("@/components/inbox/composer/TemplateMenu", () => ({
  resolveSlash: () => ({ open: false, query: "" }),
  TemplateMenu: () => null,
}));
vi.mock("@/components/inbox/composer/MentionMenu", () => ({
  resolverMencao: () => null,
  opcoesDeMencao: () => [],
  MentionMenu: () => null,
}));
vi.mock("@/components/inbox/composer/AttachMenu", () => ({ AttachMenu: () => null }));
vi.mock("@/components/inbox/composer/AttachmentPreviewDialog", () => ({
  AttachmentPreviewDialog: () => null,
}));
vi.mock("@/components/inbox/composer/ContactPickerDialog", () => ({
  ContactPickerDialog: () => null,
}));
vi.mock("@/components/inbox/composer/AudioRecorder", () => ({ AudioRecorder: () => null }));
vi.mock("@/components/inbox/composer/EmojiButton", () => ({ EmojiButton: () => null }));

import { Composer } from "./Composer";

const CONVERSA = "conv-1";
const CONVERSA_NOVA = "conv-nova";

/** A recusa real da rota, com o detalhe que a #3732 passou a mandar. */
function recusaComContinua(nome: string | null, propria = false) {
  return new ApiError(
    409,
    "conversa_em_numero_de_outro_atendente",
    {
      channel_session_id: "sessao-do-colega",
      conversa_que_continua: { id: CONVERSA_NOVA, nome, propria },
    },
    "req-3732",
    "Esta conversa está no número de outro atendente.",
  );
}

function renderComposer(onAbrirConversa: (id: string) => void = vi.fn()) {
  const vista = render(
    <Composer conversationId={CONVERSA} onAbrirConversa={onAbrirConversa} />,
  );
  return { ...vista, onAbrirConversa };
}

beforeEach(() => {
  sendMutate.mockReset();
  noteMutate.mockReset();
  erroDoEnvio.valor = null;
});

describe("#3732 — a recusa do envio leva para a conversa que continua", () => {
  it("⭐ a faixa diz para onde ir e o botão abre a conversa nova", async () => {
    erroDoEnvio.valor = recusaComContinua("Bruno Vendedor");
    const { onAbrirConversa } = renderComposer();

    const campo = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
    fireEvent.change(campo, { target: { value: "bom dia" } });
    await userEvent.click(screen.getByLabelText("Enviar"));

    expect(sendMutate).toHaveBeenCalledTimes(1);
    const faixa = screen.getByTestId("conversa-continua-em-outro-numero");
    expect(faixa).toHaveTextContent("pelo número de Bruno Vendedor");
    expect(faixa).toHaveTextContent("Abra a conversa para responder.");

    await userEvent.click(screen.getByRole("button", { name: "Abrir a conversa" }));
    expect(onAbrirConversa).toHaveBeenCalledWith(CONVERSA_NOVA);
  });

  it("a caixa fica TRAVADA enquanto a faixa está de pé", async () => {
    erroDoEnvio.valor = recusaComContinua("Ana Vendedora", true);
    renderComposer();

    const campo = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
    fireEvent.change(campo, { target: { value: "bom dia" } });
    await userEvent.click(screen.getByLabelText("Enviar"));

    // Depois da recusa: o campo desabilitado — é o MESMO `isDisabled` de
    // sempre (o que trava campo, anexo, emoji e envio), não um segundo caminho.
    expect(screen.getByLabelText("Mensagem")).toBeDisabled();
    expect(screen.getByLabelText("Enviar")).toBeDisabled();

    // E a frase é a do PRÓPRIO número, não a de outra pessoa.
    expect(screen.getByTestId("conversa-continua-em-outro-numero")).toHaveTextContent(
      "no seu número",
    );
  });

  it("CONTROLE: recusa sem a conversa que continua não monta faixa nenhuma", async () => {
    erroDoEnvio.valor = new ApiError(
      409,
      "conversa_em_numero_de_outro_atendente",
      { channel_session_id: "sessao-do-colega" },
      "req-3732",
      "Esta conversa está no número de outro atendente.",
    );
    renderComposer();

    const campo = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
    fireEvent.change(campo, { target: { value: "bom dia" } });
    await userEvent.click(screen.getByLabelText("Enviar"));

    expect(screen.queryByTestId("conversa-continua-em-outro-numero")).toBeNull();
    expect(screen.getByLabelText("Mensagem")).not.toBeDisabled();
  });
});
