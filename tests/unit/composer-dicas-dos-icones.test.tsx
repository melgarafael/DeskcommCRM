/**
 * #3268 — a dica dos TRÊS ícones da linha de ações do compositor.
 *
 * O #3296 entregou as dicas do "+" (anexos) e do emoji; este arquivo fecha o
 * terceiro ("Sugerir resposta") e prova o contrato nos TRÊS de uma vez, pela
 * TELA e não pela leitura do fonte: passar o mouse mostra o balão com o rótulo
 * DAQUELE ícone, o foco por TECLADO também o mostra, e sair (ou perder o foco)
 * o esconde. Assim, tirar o `Tooltip` de qualquer um dos três gatilhos deixa o
 * caso daquele ícone vermelho.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

// O emoji-mart real é pesado para o jsdom: o picker vira um stub (nunca é
// aberto aqui — a dica nasce do hover/foco, não do clique).
vi.mock("@emoji-mart/react", () => ({ default: () => <div>picker-fake</div> }));
vi.mock("@emoji-mart/data", () => ({ default: {} }));

const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: (...args: unknown[]) => postMock(...args) },
}));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { AttachMenu } from "@/components/inbox/composer/AttachMenu";
import { DraftReplyButton } from "@/components/inbox/composer/DraftReplyButton";
import { EmojiButton } from "@/components/inbox/composer/EmojiButton";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/inbox/Composer";

// O Composer usa os hooks de envio/anexo; a linha de ações não depende deles.
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  usePaisDaOrgAtiva: () => null,
}));

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);

/**
 * O jsdom não calcula layout: todo `getBoundingClientRect` devolve um retângulo
 * de 0×0. O Radix mede a "área de graça" entre o gatilho e o balão para saber
 * quando o ponteiro saiu de vez — com tudo zerado a dica não fecha nunca. Aqui
 * o teste entrega o retângulo que o navegador daria, e só então o movimento de
 * sair do ícone tem geometria para ser medido.
 */
function darLayout(el: Element, r: { top: number; left: number; width: number; height: number }) {
  vi.spyOn(el as HTMLElement, "getBoundingClientRect").mockReturnValue({
    x: r.left,
    y: r.top,
    top: r.top,
    left: r.left,
    right: r.left + r.width,
    bottom: r.top + r.height,
    width: r.width,
    height: r.height,
    toJSON: () => ({}),
  } as DOMRect);
}

beforeEach(() => {
  postMock.mockReset();
});

/** Os três ícones: como montar e qual é o rótulo/dica DAQUELE ícone. */
const ICONES = [
  {
    nome: "anexos",
    rotulo: /anexar/i,
    dica: "Anexar",
    // A dica de outro ícone não pode vazar para este.
    alheia: "Sugerir resposta",
    montar: () => <AttachMenu onPick={vi.fn()} />,
  },
  {
    nome: "emoji",
    rotulo: /emoji/i,
    dica: "Emoji",
    alheia: "Anexar",
    montar: () => <EmojiButton onPick={vi.fn()} />,
  },
  {
    nome: "Sugerir resposta",
    rotulo: /sugerir resposta/i,
    dica: "Sugerir resposta",
    alheia: "Anexar",
    montar: () => <DraftReplyButton conversationId="conv-1" onDraft={vi.fn()} />,
  },
] as const;

describe.each(ICONES)("dica do ícone de $nome (#3268)", ({ rotulo, dica, alheia, montar }) => {
  it("passar o mouse mostra a dica e sair do ícone a esconde", async () => {
    const user = userEvent.setup();
    render(wrap(montar()));
    // Sem ponteiro não há balão: a dica nasce do hover, não do render.
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const botao = screen.getByRole("button", { name: rotulo });
    darLayout(botao, { top: 100, left: 100, width: 44, height: 44 });
    await user.hover(botao);

    const balao = await screen.findByRole("tooltip", {}, { timeout: 2000 });
    expect(balao).toHaveTextContent(dica);
    expect(balao).not.toHaveTextContent(alheia);
    darLayout(balao, { top: 50, left: 90, width: 64, height: 40 });

    // Sair do ícone: o ponteiro continua andando para FORA do gatilho e do
    // balão. O Radix mantém a dica viva por uma "área de graça" entre os dois
    // (para quem vai do botão ao texto) e só a fecha no `pointermove` seguinte
    // — é esse movimento que o navegador faz sozinho e que aqui é declarado.
    await user.pointer({ target: document.body, coords: { clientX: 600, clientY: 600 } });
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });

  it("o foco por TECLADO revela a dica, e perdê-lo a esconde", async () => {
    const user = userEvent.setup();
    render(wrap(montar()));

    // Tab, não `.focus()`: é o caminho de quem não tem mouse.
    await user.tab();
    const botao = screen.getByRole("button", { name: rotulo });
    expect(botao).toHaveFocus();

    const balao = await screen.findByRole("tooltip", {}, { timeout: 2000 });
    expect(balao).toHaveTextContent(dica);

    await user.tab(); // o foco sai do ícone
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  });
});

describe("a dica não muda a linha de ações do compositor", () => {
  it("os três gatilhos seguem filhos DIRETOS da linha, com a classe de antes", () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <Composer conversationId="conv-1" />
      </QueryClientProvider>,
    );

    const anexos = screen.getByRole("button", { name: /anexar/i });
    const linha = anexos.parentElement;
    // A fileira é a mesma (`flex items-end gap-2`) e nada foi inserido entre ela
    // e os botões: Provider/Tooltip/Trigger do Radix não criam nó no DOM.
    expect(linha?.className).toContain("items-end");
    expect(screen.getByRole("button", { name: /emoji/i }).parentElement).toBe(linha);
    expect(screen.getByRole("button", { name: /sugerir resposta/i }).parentElement).toBe(linha);

    // O balão fechado não ocupa lugar nenhum na fileira.
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("o botão do 'Sugerir resposta' mantém exatamente a classe de um Button size=\"icon\" sem dica", () => {
    render(wrap(<DraftReplyButton conversationId="conv-1" onDraft={vi.fn()} />));
    const comDica = screen.getByRole("button", { name: /sugerir resposta/i });

    const { unmount } = render(
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-9 w-9 shrink-0"
        aria-label="referência"
      />,
    );
    const semDica = screen.getByRole("button", { name: "referência" });
    expect(comDica.className).toBe(semDica.className);
    unmount();
  });
});
