/**
 * A CAIXA DE MENSAGEM BLOQUEADA ATÉ ASSUMIR (#3012).
 *
 * Com a opção da ORGANIZAÇÃO ligada, quem abre uma conversa sem responsável não
 * pode digitar nem enviar até clicar em "Assumir". O que este arquivo segura:
 *
 *  1. com a opção LIGADA e a conversa SEM dono, a caixa fica travada — o campo
 *     desabilitado no DOM e a ação de envio barrada (nem o Enter passa);
 *  2. com a opção LIGADA, depois de ASSUMIR (o dono passa a ser o atendente),
 *     a caixa libera e o envio funciona;
 *  3. CONTROLE: com a opção DESLIGADA, tudo se comporta como hoje nos dois
 *     estados — sem dono e com dono de outra pessoa;
 *  4. CONTROLE: o bloqueio é o MESMO caminho de sempre (`isDisabled`), medido
 *     pelo que os outros controles do compositor recebem, e não por um segundo
 *     caminho paralelo que pudesse divergir dele.
 *  5. #4148: a conversa que estava na FILA passa a ter dono no primeiro envio
 *     (o envio assume) e o campo continua em foco — a segunda mensagem sai sem
 *     clicar na caixa.
 *
 * A conversa "assumida por OUTRO atendente" não é caso à parte: a regra é uma
 * só — a caixa abre para o DONO ATUAL —, e por isso o caso do dono alheio cai no
 * mesmo lugar que o da conversa sem dono.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { composerBloqueadoAteAssumir } from "@/lib/inbox/bloqueio-ate-assumir";

type Tradutor = (texto: string) => string;

const DICIONARIO: Record<string, { es: string }> = {
  Responder: { es: "Responder" },
  "Nota interna": { es: "Nota interna" },
  Enviar: { es: "Enviar" },
  Mensagem: { es: "Mensaje" },
  "Assuma esta conversa para responder.": { es: "Asume esta conversación para responder." },
};

let idioma: "pt_BR" | "es" = "pt_BR";

vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => ((texto: string) =>
    idioma === "pt_BR" ? texto : (DICIONARIO[texto]?.es ?? texto)) as Tradutor,
}));

const { sendMutate, noteMutate } = vi.hoisted(() => ({
  sendMutate: vi.fn(),
  noteMutate: vi.fn(),
}));

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMutate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: noteMutate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
// Desde a issue #3027 o painel só é montado quando HÁ sugestão, e a consulta
// mora no compositor (este arquivo não monta `QueryClientProvider`). Uma
// sugestão pendente mantém o painel na tela: é ele o controle que mede a trava.
vi.mock("@/hooks/inbox/useRascunhoAssistido", () => ({
  useRascunhoAssistido: () => ({ sugestao: { id: "d1", status: "pending" }, invalidar: () => {} }),
}));
vi.mock("@/components/inbox/composer/DraftReplyButton", () => ({
  DraftReplyButton: () => null,
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [], isLoading: false }),
  // Sem grupo (#3245): a barra e o slash-menu são os de antes dos grupos, que é
  // o caminho que estes casos medem.
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
// O painel de revisão é o controle que MEDE o caminho único: ele recebe o
// `isDisabled` de dentro do compositor, como o campo, o anexo e o emoji.
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

const ATENDENTE = "u1";
const OUTRO = "u2";

/** O compositor com a decisão REAL do InboxLayout: a regra pura alimenta a prop. */
function renderComposer(entrada: {
  ligada: boolean | undefined;
  donoDaConversa: string | null;
}) {
  const aguardandoAssumir = composerBloqueadoAteAssumir({
    ligada: entrada.ligada,
    donoDaConversa: entrada.donoDaConversa,
    atendenteId: ATENDENTE,
  });
  const vista = render(
    <Composer
      conversationId="conv-1"
      contactName="Rafael Melgaço"
      aguardandoAssumir={aguardandoAssumir}
    />,
  );
  return { ...vista, aguardandoAssumir };
}

beforeEach(() => {
  idioma = "pt_BR";
  sendMutate.mockReset();
  noteMutate.mockReset();
});

describe("a regra, isolada (opção da ORGANIZAÇÃO × dono da conversa)", () => {
  it("ligada + conversa sem dono: bloqueia", () => {
    expect(
      composerBloqueadoAteAssumir({ ligada: true, donoDaConversa: null, atendenteId: ATENDENTE }),
    ).toBe(true);
  });

  it("ligada + dono é OUTRO atendente: bloqueia", () => {
    expect(
      composerBloqueadoAteAssumir({ ligada: true, donoDaConversa: OUTRO, atendenteId: ATENDENTE }),
    ).toBe(true);
  });

  it("ligada + dono é o próprio atendente: libera (é o que 'Assumir' produz)", () => {
    expect(
      composerBloqueadoAteAssumir({ ligada: true, donoDaConversa: ATENDENTE, atendenteId: ATENDENTE }),
    ).toBe(false);
  });

  it("DESLIGADA (o padrão): libera nos dois estados", () => {
    for (const dono of [null, OUTRO, ATENDENTE]) {
      expect(
        composerBloqueadoAteAssumir({ ligada: false, donoDaConversa: dono, atendenteId: ATENDENTE }),
      ).toBe(false);
    }
    expect(
      composerBloqueadoAteAssumir({ ligada: undefined, donoDaConversa: null, atendenteId: ATENDENTE }),
    ).toBe(false);
  });

  it("sem atendente identificado libera — falha para o lado de sempre", () => {
    expect(
      composerBloqueadoAteAssumir({ ligada: true, donoDaConversa: null, atendenteId: null }),
    ).toBe(false);
  });
});

describe("opção LIGADA, conversa SEM dono: a caixa não aceita texto nem envio", () => {
  it("o campo fica desabilitado, a faixa explica e o Enter não envia", async () => {
    renderComposer({ ligada: true, donoDaConversa: null });

    const campo = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
    // Prova no DOM: o caminho pedido pela issue — "não pode digitar".
    expect(campo).toBeDisabled();
    expect(screen.getByTestId("aviso-assumir")).toBeInTheDocument();

    // Digitação realista: o `userEvent` respeita o disabled e o campo segue vazio.
    await userEvent.type(campo, "posso responder sem assumir?");
    expect(campo.value).toBe("");

    // A AÇÃO de envio barrada, mesmo com o texto forçado no campo (a forma de
    // burlar a interface): o `handleSubmit` recusa entrar.
    fireEvent.change(campo, { target: { value: "texto forçado" } });
    fireEvent.keyDown(campo, { key: "Enter" });
    await userEvent.click(screen.getByTestId("aviso-assumir"));

    expect(sendMutate).not.toHaveBeenCalled();
    expect(noteMutate).not.toHaveBeenCalled();
  });

  it("nenhum Enviar habilitado aparece", async () => {
    renderComposer({ ligada: true, donoDaConversa: null });

    const enviar = screen.queryByLabelText("Enviar") as HTMLButtonElement | null;
    // Ou o botão não existe (campo vazio, sem texto digitável), ou existe
    // desabilitado — nunca clicável.
    expect(enviar === null || enviar.disabled).toBe(true);
  });

  it("é o MESMO caminho de disable do resto do compositor (não um segundo)", () => {
    renderComposer({ ligada: true, donoDaConversa: null });
    expect(screen.getByTestId("reply-review-panel")).toHaveAttribute("data-disabled", "true");
  });

  it("a conversa JÁ assumida por outro também trava (mesma regra)", () => {
    renderComposer({ ligada: true, donoDaConversa: OUTRO });
    expect(screen.getByLabelText("Mensagem")).toBeDisabled();
  });
});

describe("opção LIGADA, depois de ASSUMIR: a caixa libera e o envio funciona", () => {
  it("com o dono no próprio atendente o texto entra e a mensagem sai", async () => {
    renderComposer({ ligada: true, donoDaConversa: ATENDENTE });

    const campo = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
    expect(campo).not.toBeDisabled();
    expect(screen.queryByTestId("aviso-assumir")).toBeNull();
    expect(screen.getByTestId("reply-review-panel")).toHaveAttribute("data-disabled", "false");

    await userEvent.type(campo, "Oi, tudo bem?");
    await userEvent.click(screen.getByLabelText("Enviar"));

    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate.mock.calls[0]![0]).toMatchObject({
      conversation_id: "conv-1",
      body: "Oi, tudo bem?",
      type: "text",
    });
  });

  it("nota interna também passa quando a conversa é sua", async () => {
    renderComposer({ ligada: true, donoDaConversa: ATENDENTE });

    await userEvent.click(screen.getByText("Nota interna"));
    await userEvent.type(screen.getByLabelText("Mensagem"), "combinado com o time");
    await userEvent.click(screen.getByLabelText("Enviar"));

    expect(noteMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate).not.toHaveBeenCalled();
  });
});

describe("CONTROLE: opção DESLIGADA — hoje, nos dois estados", () => {
  it("conversa sem dono segue aceitando e enviando como antes", async () => {
    renderComposer({ ligada: false, donoDaConversa: null });

    const campo = screen.getByLabelText("Mensagem");
    expect(campo).not.toBeDisabled();
    expect(screen.queryByTestId("aviso-assumir")).toBeNull();

    await userEvent.type(campo, "resposta de quem não assumiu");
    await userEvent.click(screen.getByLabelText("Enviar"));

    expect(sendMutate).toHaveBeenCalledTimes(1);
  });

  it("conversa com dono de OUTRA pessoa segue aceitando, como hoje", async () => {
    renderComposer({ ligada: false, donoDaConversa: OUTRO });

    const campo = screen.getByLabelText("Mensagem");
    expect(campo).not.toBeDisabled();

    await userEvent.type(campo, "ajudando um colega");
    await userEvent.click(screen.getByLabelText("Enviar"));

    expect(sendMutate).toHaveBeenCalledTimes(1);
  });
});

/**
 * A CONVERSA DA FILA QUE PASSA A TER DONO NO PRIMEIRO ENVIO (#4148).
 *
 * O gesto é o do atendente: clicar no "Enviar". O clique põe o foco no BOTÃO, e
 * o mesmo commit que limpa o campo troca esse botão pelo gravador — o nó focado
 * sai da tela e o foco cai no `body`. Daí a segunda mensagem não sair: as teclas
 * não têm para onde ir. Enviar pelo TECLADO (Enter) sempre manteve o foco, e a
 * assunção em si também não o tira — o `textarea` é o MESMO nó depois do
 * re-render. É o clique, e só ele, que deixa o campo órfão.
 */
describe("a conversa da fila, depois do primeiro envio (#4148)", () => {
  it("o campo volta a ter o foco: a segunda mensagem sai sem clicar nele", async () => {
    const vista = renderComposer({ ligada: false, donoDaConversa: null });

    const campo = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
    await userEvent.type(campo, "primeira mensagem");
    expect(campo).toHaveFocus();

    await userEvent.click(screen.getByLabelText("Enviar"));
    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect(campo.value).toBe("");

    // O ENVIO ASSUME a conversa: o dono passa a ser o atendente, e o compositor
    // re-renderiza com a decisão nova — é o que o `InboxLayout` faz quando a
    // lista de conversas invalida depois do envio. O nó do campo é o MESMO.
    vista.rerender(
      <Composer
        conversationId="conv-1"
        contactName="Rafael Melgaço"
        aguardandoAssumir={composerBloqueadoAteAssumir({
          ligada: false,
          donoDaConversa: ATENDENTE,
          atendenteId: ATENDENTE,
        })}
      />,
    );
    expect(screen.getByLabelText("Mensagem")).toBe(campo);
    await waitFor(() => expect(campo).toHaveFocus());

    // E a segunda sai pelo teclado, sem passar pelo mouse.
    await userEvent.type(campo, "segunda mensagem{Enter}");
    expect(sendMutate).toHaveBeenCalledTimes(2);
    expect(sendMutate.mock.calls[1]![0]).toMatchObject({
      body: "segunda mensagem",
      type: "text",
    });
  });
});
