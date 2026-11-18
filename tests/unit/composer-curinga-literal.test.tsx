import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O GATE DO CURINGA LITERAL (#2744, opção A).
 *
 * O que está em disputa: um contato SEM nome de gente + um texto com
 * `{{nome}}`/`{{primeiro_nome}}` literal. Em modo RESPOSTA, o literal iria
 * CRU para o cliente — o defeito é irreversível assim que sai. A trava barra o
 * ENVIO, mostra o motivo junto do botão (persistente, não o toast que some) e
 * deixa o CAMPO editável, porque a instrução é "edite antes de enviar".
 *
 * As três fronteiras, cada uma com o `not.toHaveBeenCalled()` do caminho
 * oposto: (a) resposta barrada; (b) o MESMO texto em nota passa; (c) contato
 * com nome não sofre bloqueio; (d) chave desconhecida (`{{codigo}}`) também não.
 */

const sendMock = vi.fn();
const createNoteMock = vi.fn();

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: createNoteMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" {...props} />
    </QueryClientProvider>,
  );
}

describe("Composer + curinga de nome literal (#2744)", () => {
  beforeEach(() => {
    sendMock.mockClear();
    createNoteMock.mockClear();
  });

  it("(a) resposta com `{{primeiro_nome}}` e contato sem nome: barrar o envio e mostrar o motivo", () => {
    renderComposer({ contactName: null, contactDisplayName: null });
    const campo = screen.getByLabelText(/mensagem/i);

    fireEvent.change(campo, { target: { value: "Oi {{primeiro_nome}}, segue o catálogo!" } });
    // Enter é o caminho real de envio do operador; o botão também fica travado.
    fireEvent.keyDown(campo, { key: "Enter" });

    expect(sendMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("aviso-curinga-literal")).toBeInTheDocument();
    // O campo continua EDITÁVEL — a instrução é editar antes de enviar.
    expect(campo).not.toBeDisabled();
  });

  it("(b) o MESMO texto em nota interna passa: a nota vai para o time", () => {
    renderComposer({ contactName: null, contactDisplayName: null });
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));

    const campo = screen.getByPlaceholderText(/nota interna/i);
    fireEvent.change(campo, { target: { value: "Cliente sem nome — {{nome}} ficou literal" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: "conv-1" }),
      expect.anything(),
    );
    expect(sendMock).not.toHaveBeenCalled();
    // Sem resposta, sem aviso de resposta.
    expect(screen.queryByTestId("aviso-curinga-literal")).not.toBeInTheDocument();
  });

  it("(c) contato COM name: nada barrado — o curinga resolve e a resposta sai", () => {
    renderComposer({ contactName: "Rafael Melgaço" });
    const campo = screen.getByLabelText(/mensagem/i);

    fireEvent.change(campo, { target: { value: "Oi {{nome}}, tudo bem?" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(sendMock).toHaveBeenCalled();
    expect(screen.queryByTestId("aviso-curinga-literal")).not.toBeInTheDocument();
  });

  it("(c') contato sem name mas COM display_name de gente: também não barra", () => {
    renderComposer({ contactName: null, contactDisplayName: "Ana Paula" });
    const campo = screen.getByLabelText(/mensagem/i);

    fireEvent.change(campo, { target: { value: "Oi {{primeiro_nome}}" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(sendMock).toHaveBeenCalled();
    expect(screen.queryByTestId("aviso-curinga-literal")).not.toBeInTheDocument();
  });

  it("(d) chave desconhecida não barra: `{{codigo}}` cru segue como texto", () => {
    renderComposer({ contactName: null, contactDisplayName: null });
    const campo = screen.getByLabelText(/mensagem/i);

    fireEvent.change(campo, { target: { value: "Seu cupom é {{codigo}}" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(sendMock).toHaveBeenCalled();
    expect(screen.queryByTestId("aviso-curinga-literal")).not.toBeInTheDocument();
  });

  it("apagar o literal destrava o envio: o aviso some e a resposta sai", () => {
    renderComposer({ contactName: null, contactDisplayName: null });
    const campo = screen.getByLabelText(/mensagem/i);

    fireEvent.change(campo, { target: { value: "Oi {{primeiro_nome}}" } });
    expect(screen.getByTestId("aviso-curinga-literal")).toBeInTheDocument();

    fireEvent.change(campo, { target: { value: "Oi, tudo bem?" } });
    expect(screen.queryByTestId("aviso-curinga-literal")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(sendMock).toHaveBeenCalled();
  });
});
