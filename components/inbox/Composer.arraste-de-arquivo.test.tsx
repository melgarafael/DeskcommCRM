/**
 * ARRASTAR ARQUIVO PARA DENTRO DO COMPOSITOR (#3708).
 *
 * A issue pede drag&drop para anexar em conversa de WhatsApp. O risco desta
 * fatia não é o gesto — é o SEGUNDO CAMINHO: um `drop` que chame upload próprio
 * diverge do botão no limite de tamanho, no tipo aceito, na prévia e no retry,
 * e diverge principalmente no BLOQUEIO (o botão `disabled` não impede um
 * arquivo de ser solto em cima do compositor).
 *
 * O que este arquivo segura, um por um:
 *
 *   1. o drop entrega o arquivo pela MESMA função de anexo do botão — medido
 *      pelo que chega à prévia e pelo upload que sai dela (mesmo arquivo, mesmo
 *      destino, mesma conversa);
 *   2. a conversa bloqueada até assumir (#3012) NÃO aceita drop — e o mesmo
 *      drop, na mesma tela liberada, anexa: é o CONTROLE que prova que o verde
 *      do bloqueio não é ausência de feature;
 *   3. a janela de 24h barra o drop na RESPOSTA e libera na NOTA, como barra o
 *      campo e o "+" — mesma guarda (`respostaBarrada`), não uma nova;
 *   4. `dragover` previne o default (senão o navegador abre o arquivo e a
 *      conversa se perde), inclusive com a caixa bloqueada;
 *   5. o realce da área sobrevive ao `dragleave` que dispara ao passar sobre um
 *      FILHO (contador), e some quando o ponteiro sai de fato;
 *   6. arrastar TEXTO não vira anexo, e um segundo drop não substitui em
 *      silêncio o que já está na prévia.
 *
 * Por que o "botão" aqui é um `<input type="file">` mockado: o `AttachMenu`
 * real envolve o Radix do popover, que não acrescenta nada ao caminho medido —
 * o contrato dele é `onPick(file)`, e é exatamente o que o dublê entrega. A
 * prévia também é dublê, pelo motivo oposto: ela é o PONTO DE MEDIÇÃO (o que
 * chega nela, e o que sai dela pelo `onSend` é o upload de verdade, mockado só
 * na borda de rede).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";

const deps = vi.hoisted(() => ({
  uploadMutateAsync: vi.fn(),
  sendMutate: vi.fn(),
  noteMutate: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: deps.sendMutate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: deps.noteMutate, isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: deps.uploadMutateAsync, isPending: false }),
}));
// A consulta do rascunho assistido mora num hook próprio e este arquivo não
// monta `QueryClientProvider` — mesmo tratamento dos outros testes do composer.
vi.mock("@/hooks/inbox/useRascunhoAssistido", () => ({
  useRascunhoAssistido: () => ({ sugestao: undefined, invalidar: () => {} }),
}));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  // Sem grupo (#3245): a barra e o slash-menu são os de antes dos grupos.
  useGruposDeRespostas: () => ({ data: [] }),
  useMessageTemplates: () => ({ data: [] }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

vi.mock("@/lib/inbox/clipboard-image", () => ({ imagemDoClipboard: vi.fn(() => null) }));
vi.mock("@/lib/notifications/mentions", () => ({
  embutirMencoes: vi.fn((body: string) => body),
  podarMencoes: vi.fn((_texto: string, m: unknown) => m),
  resolverMencao: vi.fn(() => null),
}));
vi.mock("@/lib/messaging/contact-card", () => ({ resolveSharedContact: vi.fn() }));

// O BOTÃO DE ANEXAR, reduzido ao contrato: escolher o arquivo e entregá-lo ao
// `onPick` do compositor. É o mesmo `onPick` que o menu "+" real recebe.
vi.mock("@/components/inbox/composer/AttachMenu", () => ({
  AttachMenu: ({ onPick }: { onPick: (file: File) => void }) => (
    <input
      type="file"
      aria-label="Anexar arquivo do botão"
      onChange={(e) => {
        const arquivo = e.target.files?.[0];
        if (arquivo) onPick(arquivo);
      }}
    />
  ),
}));

// O PONTO DE MEDIÇÃO: a prévia mostra a fila e o destino que recebeu, e o
// `onSend` dela é o caminho de envio de verdade do compositor (`enviarAnexos`).
vi.mock("@/components/inbox/composer/AttachmentPreviewDialog", () => ({
  AttachmentPreviewDialog: ({
    files,
    notaInterna,
    onSend,
  }: {
    files: File[];
    notaInterna?: boolean;
    onSend: (caption: string) => void;
  }) => {
    if (!files.length) return null;
    return (
      <div data-testid="previa">
        <span data-testid="previa-destino">{notaInterna ? "nota" : "mensagem"}</span>
        {files.map((f) => (
          <span key={f.name} data-testid="previa-arquivo">
            {f.name}
          </span>
        ))}
        <button type="button" onClick={() => onSend("")}>
          Enviar anexo
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

import { Composer } from "./Composer";

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  return render(<Composer conversationId="conv-1" contactName="Rafael" {...props} />);
}

const arquivoDe = (nome: string, tipo = "application/pdf") =>
  new File(["conteudo do arquivo"], nome, { type: tipo });

const area = () => screen.getByTestId("composer");
const realce = () => screen.queryByTestId("arraste-de-arquivo");

/** Um arraste de ARQUIVO por cima da área — o que o navegador entrega. */
function arrastarArquivo(alvo: HTMLElement = area()) {
  fireEvent.dragEnter(alvo, { dataTransfer: { types: ["Files"] } });
  return fireEvent.dragOver(alvo, { dataTransfer: { types: ["Files"] } });
}

/** Solta os arquivos na área, como o navegador entrega no `drop`. */
function soltar(alvo: HTMLElement, arquivos: File[]) {
  return fireEvent.drop(alvo, { dataTransfer: { types: ["Files"], files: arquivos } });
}

/** O caminho de envio que a prévia percorre — o que sai, para onde e com quê. */
async function caminhoDaPrevia() {
  const destino = screen.getByTestId("previa-destino").textContent;
  const arquivos = screen.getAllByTestId("previa-arquivo").map((n) => n.textContent);
  await userEvent.click(screen.getByText("Enviar anexo"));
  const envio = deps.uploadMutateAsync.mock.calls[0]?.[0] as
    | { conversationId: string; file: File; destino: string }
    | undefined;
  return {
    previa: { destino, arquivos },
    envio: envio ? { conversationId: envio.conversationId, nome: envio.file.name, destino: envio.destino } : null,
  };
}

beforeEach(() => {
  deps.uploadMutateAsync.mockReset();
  deps.sendMutate.mockReset();
  deps.noteMutate.mockReset();
  deps.uploadMutateAsync.mockResolvedValue({
    storage_path: "conv-1/contrato.pdf",
    media_mime: "application/pdf",
    media_size_bytes: 17,
    kind: "document",
  });
});

describe("o drop cai na MESMA função de anexo do botão", () => {
  it("⭐ clique e drop produzem a mesma prévia e o mesmo upload", async () => {
    const arquivo = arquivoDe("contrato.pdf");

    // ── PELO BOTÃO ────────────────────────────────────────────────────────
    const peloBotao = renderComposer();
    fireEvent.change(screen.getByLabelText("Anexar arquivo do botão"), {
      target: { files: [arquivo] },
    });
    const caminhoDoBotao = await caminhoDaPrevia();
    peloBotao.unmount();
    deps.uploadMutateAsync.mockClear();

    // ── PELO DROP ─────────────────────────────────────────────────────────
    renderComposer();
    arrastarArquivo();
    soltar(area(), [arquivo]);
    const caminhoDoDrop = await caminhoDaPrevia();

    // O que chega à prévia e o que sobe são os MESMOS nos dois gestos: um
    // segundo caminho de upload apareceria aqui como destino, nome ou conversa
    // diferentes — ou como uma chamada de upload a mais.
    expect(caminhoDoDrop).toEqual(caminhoDoBotao);
    expect(caminhoDoDrop.previa).toEqual({ destino: "mensagem", arquivos: ["contrato.pdf"] });
    expect(caminhoDoDrop.envio).toEqual({
      conversationId: "conv-1",
      nome: "contrato.pdf",
      destino: "mensagem",
    });
    expect(deps.uploadMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("em NOTA INTERNA o drop sai pela rota da nota, como o botão", async () => {
    renderComposer({ initialMode: "note" });
    soltar(area(), [arquivoDe("print.png", "image/png")]);

    expect(screen.getByTestId("previa-destino").textContent).toBe("nota");
    await userEvent.click(screen.getByText("Enviar anexo"));
    expect(deps.uploadMutateAsync.mock.calls[0]![0]).toMatchObject({
      conversationId: "conv-1",
      destino: "nota",
    });
  });

  it("vários arquivos soltos de uma vez entram na mesma fila, em ordem", async () => {
    renderComposer();
    soltar(area(), [arquivoDe("a.pdf"), arquivoDe("b.pdf")]);

    expect(screen.getAllByTestId("previa-arquivo").map((n) => n.textContent)).toEqual([
      "a.pdf",
      "b.pdf",
    ]);
  });
});

describe("a conversa bloqueada não aceita drop", () => {
  it("⭐ caixa travada até ASSUMIR: o drop não abre prévia nem sobe byte", () => {
    renderComposer({ aguardandoAssumir: true });

    // O realce também não aparece: a área não está aceitando nada, e prometer
    // que aceita para depois ignorar o arquivo seria pior que não avisar.
    arrastarArquivo();
    expect(realce()).toBeNull();

    soltar(area(), [arquivoDe("contrato.pdf")]);

    expect(screen.queryByTestId("previa")).toBeNull();
    expect(deps.uploadMutateAsync).not.toHaveBeenCalled();
    expect(deps.sendMutate).not.toHaveBeenCalled();
    expect(deps.noteMutate).not.toHaveBeenCalled();
  });

  it("CONTROLE: a mesma tela, já assumida, aceita o mesmo drop", async () => {
    renderComposer({ aguardandoAssumir: false });
    soltar(area(), [arquivoDe("contrato.pdf")]);

    expect(screen.getByTestId("previa-arquivo").textContent).toBe("contrato.pdf");
    await userEvent.click(screen.getByText("Enviar anexo"));
    expect(deps.uploadMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("⭐ janela de 24h fechada barra o drop na RESPOSTA e libera na NOTA", () => {
    // Mesma guarda do campo e do "+": `respostaBarrada`. Se o drop tivesse
    // regra própria, ou anexaria com a janela fechada (mandando arquivo ao
    // cliente por uma porta que o botão fecha), ou barraria a nota interna —
    // que é justamente onde o operador registra por que a conversa esfriou.
    const resposta = renderComposer({ janelaFechada: "A janela de 24h está fechada." });
    soltar(area(), [arquivoDe("contrato.pdf")]);
    expect(screen.queryByTestId("previa")).toBeNull();
    expect(deps.uploadMutateAsync).not.toHaveBeenCalled();
    resposta.unmount();

    renderComposer({ janelaFechada: "A janela de 24h está fechada.", initialMode: "note" });
    soltar(area(), [arquivoDe("contrato.pdf")]);
    expect(screen.getByTestId("previa-destino").textContent).toBe("nota");
  });
});

describe("dragover previne o default — senão o navegador abre o arquivo", () => {
  it("⭐ o dragover de arquivo é cancelado (a conversa não vira um PDF na aba)", () => {
    renderComposer();

    // `fireEvent` devolve `false` quando o handler chamou `preventDefault`.
    expect(arrastarArquivo()).toBe(false);
  });

  it("CONTROLE: arrastar TEXTO não é cancelado — o navegador segue dono do gesto", () => {
    renderComposer();
    const naoCancelado = fireEvent.dragOver(area(), {
      dataTransfer: { types: ["text/plain"] },
    });
    expect(naoCancelado).toBe(true);
  });

  it("com a caixa travada o default também é cancelado: recusar o anexo não é navegar", () => {
    renderComposer({ aguardandoAssumir: true });
    expect(arrastarArquivo()).toBe(false);
  });
});

describe("o realce da área (`dragenter`/`dragleave` que disparam nos filhos)", () => {
  it("⭐ um dragleave sobre o filho NÃO apaga o realce; sair de fato apaga", () => {
    renderComposer();

    fireEvent.dragEnter(area(), { dataTransfer: { types: ["Files"] } });
    expect(realce()).not.toBeNull();

    // O ponteiro entrou num filho (o campo) e o `dragleave` do pai chegou —
    // exatamente o par que faz o realce piscar quando se conta com um booleano.
    fireEvent.dragEnter(screen.getByLabelText("Mensagem"), {
      dataTransfer: { types: ["Files"] },
    });
    fireEvent.dragLeave(area(), { dataTransfer: { types: ["Files"] } });
    expect(realce(), "o realce piscou ao passar sobre o campo").not.toBeNull();

    // Saiu da área: aí sim apaga.
    fireEvent.dragLeave(area(), { dataTransfer: { types: ["Files"] } });
    expect(realce()).toBeNull();
  });

  it("o realce some quando o arquivo é solto", () => {
    renderComposer();
    arrastarArquivo();
    expect(realce()).not.toBeNull();

    soltar(area(), [arquivoDe("contrato.pdf")]);
    expect(realce()).toBeNull();
  });

  it("arrastar texto não acende o realce", () => {
    renderComposer();
    fireEvent.dragEnter(area(), { dataTransfer: { types: ["text/plain"] } });
    expect(realce()).toBeNull();
  });
});

describe("o que o drop NÃO pode atropelar", () => {
  it("soltar texto não vira anexo", () => {
    renderComposer();
    const naoCancelado = fireEvent.drop(area(), {
      dataTransfer: { types: ["text/plain"], files: [] },
    });

    // Deixar o navegador fazer o de sempre com o texto: o drop não é dono dele.
    expect(naoCancelado).toBe(true);
    expect(screen.queryByTestId("previa")).toBeNull();
  });

  it("com a prévia aberta, um segundo drop não substitui a escolha do operador", () => {
    renderComposer();
    soltar(area(), [arquivoDe("escolhido.pdf")]);
    expect(screen.getByTestId("previa-arquivo").textContent).toBe("escolhido.pdf");

    soltar(area(), [arquivoDe("outro.pdf")]);

    // A mesma recusa da colagem: trocar a fila em silêncio apagaria o que a
    // pessoa já tinha escolhido (e possivelmente legendado).
    expect(screen.getAllByTestId("previa-arquivo").map((n) => n.textContent)).toEqual([
      "escolhido.pdf",
    ]);
  });
});
