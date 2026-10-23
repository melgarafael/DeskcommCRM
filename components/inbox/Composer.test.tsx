/**
 * O curinga DIGITADO tem de interpolar como o template aplicado (#2891).
 *
 * Em 14/10/2026 o atendente digitava `{{primeiro_nome}}` à mão num contato QUE
 * TEM nome e o token saía CRU para o cliente: sem faixa de aviso, com o Enviar
 * habilitado e o `POST /api/v1/messages` levando o literal. Só o `applyTemplate`
 * (resposta rápida) interpolava — e o gate da faixa cobria apenas o contato SEM
 * nome (#2844, já mesclado). O conserto é UM: o `handleSubmit` interpola o
 * texto digitado com a MESMA fonte de contato (`contato`) que o `applyTemplate`
 * e a trava leem.
 *
 * O teste segura as duas pontas que o conserto não pode quebrar:
 *   - o que INTERPOLA (nome, primeiro_nome, fallback p/ `display_name`);
 *   - o que NÃO MEXE (chave desconhecida segue literal; contato sem nome segue
 *     barrado pela faixa do #2844).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** O que o `useT()` real devolve: uma função `texto -> string`. */
type Tradutor = (texto: string) => string;

const DICIONARIO: Record<string, { es: string }> = {
  Responder: { es: "Responder" },
  "Nota interna": { es: "Nota interna" },
  Enviar: { es: "Enviar" },
  Mensagem: { es: "Mensaje" },
  "Escreva uma mensagem…": { es: "Escribe un mensaje…" },
  "Escreva uma nota interna… (só o time vê)": { es: "Escribe una nota interna… (solo el equipo la ve)" },
  "Enter envia · Shift+Enter quebra linha": { es: "Enter envía · Shift+Enter salta de línea" },
  "Enter salva a nota · Shift+Enter quebra línea": {
    es: "Enter guarda la nota · Shift+Enter salta de línea",
  },
  "Enter salva a nota · Shift+Enter quebra linha": {
    es: "Enter guarda la nota · Shift+Enter salta de línea",
  },
  "Contato sem nome no CRM: {{nome}}/{{primeiro_nome}} ficaram literais no texto. Edite antes de enviar.": {
    es: "Contacto sin nombre en el CRM: {{nome}}/{{primeiro_nome}} quedaron como texto literal en el mensaje. Edítalo antes de enviar.",
  },
  "Atendente": { es: "Agente" },
};

function fazTradutor(idioma: "pt_BR" | "es"): Tradutor {
  return (texto) => {
    if (idioma === "pt_BR") return texto;
    return DICIONARIO[texto]?.es ?? texto;
  };
}

// `vi.mock` é hoisted para o topo do arquivo: os spies têm de nascer no mesmo
// escopo, senão a factory enxerga a const antes da inicialização.
const { sendMutate, noteMutate, toastWarning } = vi.hoisted(() => ({
  sendMutate: vi.fn(),
  noteMutate: vi.fn(),
  toastWarning: vi.fn(),
}));

let idioma: "pt_BR" | "es" = "pt_BR";

vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => fazTradutor(idioma),
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

// A consulta do rascunho assistido (issue #3027) mora num hook próprio, e este
// arquivo não monta `QueryClientProvider`: mockar aqui é o mesmo tratamento que
// outros hooks do compositor recebem. O bloco passa a ser decidido por
// `sugestao` (o mesmo sinal do painel), e quem prova a decisão é
// `Composer.sugestao.test.tsx`, com o painel REAL montado sobre uma consulta
// de verdade.
vi.mock("@/hooks/inbox/useRascunhoAssistido", () => ({
  useRascunhoAssistido: () => ({ sugestao: undefined, invalidar: () => {} }),
}));

vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));

vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [] }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: toastWarning },
}));

vi.mock("@/lib/inbox/clipboard-image", () => ({
  imagemDoClipboard: vi.fn(() => null),
}));

vi.mock("@/lib/notifications/mentions", () => ({
  embutirMencoes: vi.fn((body: string) => body),
  podarMencoes: vi.fn((_texto: string, m: unknown) => m),
  resolverMencao: vi.fn(() => null),
}));

vi.mock("@/lib/messaging/contact-card", () => ({
  resolveSharedContact: vi.fn(),
}));

// Os filhos do compositor são render de tela: o que este teste mede é o corpo que
// SAI do `handleSubmit`, então cada um vira um placeholder sem comportamento.
vi.mock("@/components/inbox/composer/ReplyReviewPanel", () => ({
  ReplyReviewPanel: () => null,
}));
// Os dois lados da assistência viram placeholders aqui: este arquivo mede o
// corpo que SAI do `handleSubmit`, e o `DraftReplyButton` real traria uma
// `useMutation` (e o `QueryClient` que este arquivo não monta) para dentro da
// medição. A decisão de qual dos dois aparece — com o painel e o botão REAIS —
// é medida em `Composer.sugestao.test.tsx`.
vi.mock("@/components/inbox/composer/DraftReplyButton", () => ({
  DraftReplyButton: () => null,
}));
vi.mock("@/components/inbox/composer/TemplateMenu", () => ({
  resolveSlash: (text: string) => {
    if (!text.startsWith("/")) return { open: false, query: "" };
    const rest = text.slice(1);
    if (/\s/.test(rest)) return { open: false, query: "" };
    return { open: true, query: rest };
  },
  TemplateMenu: () => null,
}));
vi.mock("@/components/inbox/composer/MentionMenu", () => ({
  resolverMencao: () => null,
  opcoesDeMencao: () => [],
  MentionMenu: () => null,
}));
vi.mock("@/components/inbox/composer/AttachMenu", () => ({
  AttachMenu: () => null,
}));
vi.mock("@/components/inbox/composer/AttachmentPreviewDialog", () => ({
  AttachmentPreviewDialog: () => null,
}));
vi.mock("@/components/inbox/composer/ContactPickerDialog", () => ({
  ContactPickerDialog: () => null,
}));
vi.mock("@/components/inbox/composer/AudioRecorder", () => ({
  AudioRecorder: () => null,
}));
vi.mock("@/components/inbox/composer/EmojiButton", () => ({
  EmojiButton: () => null,
}));

import { Composer } from "./Composer";

function renderComposer(opts?: {
  contactName?: string | null;
  contactDisplayName?: string | null;
  initialDraft?: string;
}) {
  return render(
    <Composer
      conversationId="conv-1"
      initialDraft={opts?.initialDraft ?? ""}
      contactName={opts?.contactName === undefined ? "Rafael Melgaço" : opts.contactName}
      contactDisplayName={opts?.contactDisplayName ?? null}
    />,
  );
}

/**
 * Digita no campo e envia — pelo botão ou pelo Enter, os DOIS caminhos que
 * chamam `handleSubmit`.
 *
 * `fireEvent.change` e não `userEvent.type`: o `type` do Testing Library
 * interpreta `{{…}}` como nome de tecla especial e corrompe o curinga literal
 * (`Oi {primeiro_nome}}`). O `change` entrega o valor inteiro de uma vez, que é
 * exatamente o que o `onChange` do compositor lê.
 */
async function enviarDigitando(texto: string, via: "botao" | "enter" = "botao") {
  // Seletores independentes de idioma: o `aria-label` do campo e o nome do
  // botão mudam com `useT` (Mensagem/Mensaje), e os dois idiomas têm de passar
  // pelo MESMO caminho do compositor.
  const campo = screen.getByRole("textbox");
  fireEvent.change(campo, { target: { value: texto } });
  if (via === "botao") {
    await userEvent.click(screen.getByRole("button", { name: /enviar/i }));
  } else {
    fireEvent.keyDown(campo, { key: "Enter" });
  }
}

beforeEach(() => {
  idioma = "pt_BR";
  sendMutate.mockReset();
  noteMutate.mockReset();
  toastWarning.mockReset();
});

describe("curinga DIGITADO interpola no envio (#2891)", () => {
  it("pt_BR: {{primeiro_nome}} digitado sai resolvido no corpo do POST", async () => {
    renderComposer({ contactName: "Rafael Melgaço" });

    await enviarDigitando("Oi {{primeiro_nome}}, tudo bem?");

    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate.mock.calls[0]![0]).toMatchObject({
      conversation_id: "conv-1",
      body: "Oi Rafael, tudo bem?",
      type: "text",
    });
  });

  it("es: o mesmo texto digitado sai resolvido no corpo do POST", async () => {
    idioma = "es";
    renderComposer({ contactName: "Rafael Melgaço" });

    await enviarDigitando("Oi {{primeiro_nome}}, tudo bem?");

    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate.mock.calls[0]![0]).toMatchObject({ body: "Oi Rafael, tudo bem?" });
  });

  it("{{nome}} digitado sai como o nome completo", async () => {
    renderComposer({ contactName: "Rafael Melgaço" });

    await enviarDigitando("Falo com {{nome}}?");

    expect(sendMutate.mock.calls[0]![0]).toMatchObject({ body: "Falo com Rafael Melgaço?" });
  });

  it("espaços e case na chave digitada também interpolam", async () => {
    renderComposer({ contactName: "Ana Paula" });

    await enviarDigitando("Oi {{ Primeiro_Nome }}!");

    expect(sendMutate.mock.calls[0]![0]).toMatchObject({ body: "Oi Ana!" });
  });

  it("fallback do CRM para o canal (#2744): sem `name`, `display_name` resolve", async () => {
    renderComposer({ contactName: null, contactDisplayName: "Rafael Melgaço" });

    await enviarDigitando("Oi {{primeiro_nome}}!");

    expect(sendMutate.mock.calls[0]![0]).toMatchObject({ body: "Oi Rafael!" });
  });

  it("a tecla Enter interpola do MESMO jeito que o botão", async () => {
    renderComposer({ contactName: "Rafael Melgaço" });

    await enviarDigitando("Oi {{primeiro_nome}}, tudo bem?", "enter");

    expect(sendMutate.mock.calls[0]![0]).toMatchObject({ body: "Oi Rafael, tudo bem?" });
  });
});

describe("o que o conserto NÃO muda (preservado, medido)", () => {
  it("chave desconhecida digitada segue literal — não é problema de nome", async () => {
    renderComposer({ contactName: "Rafael Melgaço" });

    await enviarDigitando("Cupom {{codigo}}");

    expect(sendMutate.mock.calls[0]![0]).toMatchObject({ body: "Cupom {{codigo}}" });
  });

  it("contato SEM nome: a faixa do #2844 continua barrando o envio digitado", async () => {
    renderComposer({ contactName: null, contactDisplayName: null });

    await enviarDigitando("Oi {{primeiro_nome}}, tudo bem?");

    expect(sendMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("aviso-curinga-literal")).toBeInTheDocument();
  });

  it("sem curinga nenhum o texto sai digitado, sem faixa e sem toast", async () => {
    renderComposer({ contactName: "Rafael Melgaço" });

    await enviarDigitando("Oi, tudo bem?");

    expect(sendMutate.mock.calls[0]![0]).toMatchObject({ body: "Oi, tudo bem?" });
    expect(screen.queryByTestId("aviso-curinga-literal")).not.toBeInTheDocument();
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("o campo volta ao literal no restoreOnError — o que o atendente digitou é o que resta", async () => {
    sendMutate.mockImplementation((_payload: unknown, opts: { onError: () => void }) => opts.onError());
    renderComposer({ contactName: "Rafael Melgaço" });

    await enviarDigitando("Oi {{primeiro_nome}}, tudo bem?");

    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Mensagem") as HTMLTextAreaElement).value).toBe(
      "Oi {{primeiro_nome}}, tudo bem?",
    );
  });

  it("nota interna não interpola — ela não vai ao cliente", async () => {
    renderComposer({ contactName: "Rafael Melgaço" });

    await userEvent.click(screen.getByText("Nota interna"));
    fireEvent.change(screen.getByLabelText("Mensagem"), {
      target: { value: "Viu {{primeiro_nome}} na planilha" },
    });
    await userEvent.click(screen.getByLabelText("Enviar"));

    expect(noteMutate).toHaveBeenCalledTimes(1);
    expect(noteMutate.mock.calls[0]![0]).toMatchObject({
      conversation_id: "conv-1",
      body: "Viu {{primeiro_nome}} na planilha",
    });
    expect(sendMutate).not.toHaveBeenCalled();
  });

  it("texto digitado numa conversa e enviado noutra leva o nome do contato de DESTINO", async () => {
    // O `InboxLayout` monta o compositor com chave fixa: trocar de conversa
    // mantém o texto no campo. A interpolação acontece no ENVIO, com o contato
    // da conversa para onde a mensagem vai — nunca o da conversa onde se digitou.
    const { rerender } = renderComposer({ contactName: "Rafael Melgaço" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Oi {{primeiro_nome}}" } });

    rerender(<Composer conversationId="conv-2" initialDraft="" contactName="Ana Paula" contactDisplayName={null} />);
    await userEvent.click(screen.getByRole("button", { name: /enviar/i }));

    expect(sendMutate).toHaveBeenCalledTimes(1);
    expect(sendMutate.mock.calls[0]![0]).toMatchObject({ conversation_id: "conv-2", body: "Oi Ana" });
  });
});

/**
 * No celular a tecla de retorno do teclado virtual é a de QUEBRAR LINHA — é o
 * que o próprio WhatsApp faz, e o atendente que escreve "Oi!⏎Tudo bem?" não
 * espera ver meia mensagem sair. Quem envia, no toque, é o botão.
 *
 * O ponteiro é lido NO KEYDOWN (e não no render), para o servidor e o
 * navegador desenharem a mesma coisa. jsdom não tem `matchMedia`: o dublê
 * abaixo é a única forma de o caso existir.
 */
describe("Enter no toque quebra linha; quem envia é o botão (F2)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function ponteiro(grosso: boolean) {
    vi.stubGlobal(
      "matchMedia",
      (q: string) => ({ matches: grosso && q.includes("coarse"), media: q }) as MediaQueryList,
    );
  }

  it("ponteiro grosso: Enter NÃO envia e não é cancelado (o navegador quebra a linha)", () => {
    ponteiro(true);
    renderComposer({ contactName: "Rafael Melgaço" });
    const campo = screen.getByRole("textbox");
    fireEvent.change(campo, { target: { value: "linha 1" } });
    const naoCancelado = fireEvent.keyDown(campo, { key: "Enter" });
    expect(naoCancelado).toBe(true);
    expect(sendMutate).not.toHaveBeenCalled();
  });

  it("ponteiro grosso + Ctrl+Enter ou Cmd+Enter envia", () => {
    ponteiro(true);
    renderComposer({ contactName: "Rafael Melgaço" });
    const campo = screen.getByRole("textbox");
    fireEvent.change(campo, { target: { value: "oi" } });
    fireEvent.keyDown(campo, { key: "Enter", ctrlKey: true });
    fireEvent.change(campo, { target: { value: "de novo" } });
    fireEvent.keyDown(campo, { key: "Enter", metaKey: true });
    expect(sendMutate).toHaveBeenCalledTimes(2);
  });

  it("ponteiro fino: Enter continua enviando, como sempre", () => {
    ponteiro(false);
    renderComposer({ contactName: "Rafael Melgaço" });
    const campo = screen.getByRole("textbox");
    fireEvent.change(campo, { target: { value: "oi" } });
    const naoCancelado = fireEvent.keyDown(campo, { key: "Enter" });
    expect(naoCancelado).toBe(false);
    expect(sendMutate).toHaveBeenCalledTimes(1);
  });
});

/**
 * As medidas de verdade (px por `getComputedStyle`/`getBoundingClientRect`)
 * vivem no e2e `atender-pelo-celular.spec.ts`; jsdom não aplica CSS. Aqui fica
 * a guarda barata de que as classes que produzem essas medidas não voltaram.
 */
describe("campo e alvos pensados para o toque (F2)", () => {
  it("o campo usa 16px abaixo do md (o iPhone não amplia a página) e 44px de altura", () => {
    renderComposer({ contactName: "Rafael Melgaço" });
    const campo = screen.getByRole("textbox");
    expect(campo.className).toMatch(/(^|\s)text-base(\s|$)/);
    expect(campo.className).toContain("md:text-sm");
    expect(campo.className).toMatch(/(^|\s)min-h-11(\s|$)/);
  });

  it("o botão Enviar não fixa h-9: herda os 44px do size=icon abaixo do lg", () => {
    renderComposer({ contactName: "Rafael Melgaço" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "oi" } });
    const enviar = screen.getByRole("button", { name: /enviar/i });
    expect(enviar.className).not.toMatch(/(^|\s)h-9(\s|$)/);
    expect(enviar.className).toContain("h-11");
  });
});
