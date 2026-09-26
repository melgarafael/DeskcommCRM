import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const postMock = vi.fn();

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: (...args: unknown[]) => postMock(...args) as Promise<unknown> },
}));

import { Composer } from "@/components/inbox/Composer";
import type { AvisoDeRascunho } from "@/lib/inbox/rascunho-sugerido";

/**
 * O COMPOSER COM RASCUNHO SUGERIDO (issue #1611) — "nada é enviado sem o
 * clique" provado pelo dois lados: o texto JÁ está no campo quando a tela
 * monta, e o envio (inclusive o consumo) só acontece depois do clique.
 */
const CONV = "aaaaaaaa-1111-4000-8000-000000000001";
const DRAFT = "aaaaaaaa-2222-4000-8000-000000000001";

const sugerido: AvisoDeRascunho = {
  conversationId: CONV,
  leitura: {
    estado: "sugerido",
    draftId: DRAFT,
    conversationId: CONV,
    texto: "Sua cobrança venceu hoje.",
    origem: "erp",
  },
};

function renderComposer(props: Record<string, unknown> = {}) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId={CONV} {...props} />
    </QueryClientProvider>,
  );
}

/** Simula a API do envio respondendo com sucesso (dispara o `onSuccess`). */
function enviaComSucesso() {
  sendMock.mockImplementation((_args: unknown, op?: { onSuccess?: () => void }) => {
    op?.onSuccess?.();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockReset();
  postMock.mockResolvedValue({ data: { consumido: true } });
});

describe("Composer + rascunho sugerido", () => {
  it("abre com o texto no campo e o aviso de origem — sem ter enviado nada", () => {
    renderComposer({ initialDraft: sugerido.leitura.estado === "sugerido" ? sugerido.leitura.texto : "", rascunho: sugerido });

    expect(screen.getByLabelText(/mensagem/i)).toHaveValue("Sua cobrança venceu hoje.");
    expect(screen.getByTestId("aviso-rascunho")).toHaveTextContent(/texto sugerido por/i);
    expect(screen.getByTestId("aviso-rascunho")).toHaveTextContent(/revise antes de enviar/i);
    // Critério da issue: NENHUM envio aconteceu até aqui.
    expect(sendMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("o envio só sai com o clique, e aí o rascunho é consumido com o id certo", () => {
    enviaComSucesso();
    renderComposer({
      initialDraft: sugerido.leitura.estado === "sugerido" ? sugerido.leitura.texto : "",
      rascunho: sugerido,
    });

    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: CONV, body: "Sua cobrança venceu hoje." }),
      expect.anything(),
    );
    expect(postMock).toHaveBeenCalledWith(`/api/v1/conversations/${CONV}/drafts/consume`, {
      draft_id: DRAFT,
    });
    // Uso único: depois do clique a some, porque o texto já saiu.
    expect(screen.queryByTestId("aviso-rascunho")).not.toBeInTheDocument();
  });

  it("envio FALHO não consome o rascunho — o aviso fica", () => {
    sendMock.mockImplementation(() => {
      /* a API não respondeu com sucesso: onSuccess não roda */
    });
    renderComposer({
      initialDraft: sugerido.leitura.estado === "sugerido" ? sugerido.leitura.texto : "",
      rascunho: sugerido,
    });

    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    expect(postMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("aviso-rascunho")).toBeInTheDocument();
  });

  it("rascunho vencido: campo VAZIO e aviso dizendo por quê", () => {
    renderComposer({
      rascunho: {
        conversationId: CONV,
        leitura: { estado: "indisponivel", motivo: "expirado" },
      },
    });

    expect(screen.getByLabelText(/mensagem/i)).toHaveValue("");
    expect(screen.getByTestId("aviso-rascunho")).toHaveTextContent(/expirou/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("nota interna não consome o rascunho (só a RESPOSTA usa o texto)", () => {
    enviaComSucesso();
    renderComposer({
      initialDraft: sugerido.leitura.estado === "sugerido" ? sugerido.leitura.texto : "",
      rascunho: sugerido,
    });

    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
    // Em modo nota a faixa some — e o consumo continua não tendo acontecido.
    expect(screen.queryByTestId("aviso-rascunho")).not.toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });
});
