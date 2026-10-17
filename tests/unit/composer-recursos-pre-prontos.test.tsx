import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const postMock = vi.fn();
const getMock = vi.fn();

const RECURSOS = [
  {
    id: "r-texto",
    title: "Boas vindas",
    body: "Oi {{primeiro_nome}}, tudo bem?",
    shortcut: null,
    owner_user_id: null,
    tipo: "texto",
    media_path: null,
    media_mime: null,
    media_size_bytes: null,
  },
  {
    id: "r-audio",
    title: "Áudio preço",
    body: "",
    shortcut: null,
    owner_user_id: null,
    tipo: "audio",
    media_path: "org/recursos/preco.ogg",
    media_mime: "audio/ogg",
    media_size_bytes: 1234,
  },
];

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
  useMessageTemplates: () => ({ data: RECURSOS, isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    post: (...args: unknown[]) => postMock(...args) as Promise<unknown>,
    get: (...args: unknown[]) => getMock(...args) as Promise<unknown>,
  },
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
}));

import { Composer } from "@/components/inbox/Composer";
import { BarraDeRecursos } from "@/components/inbox/composer/BarraDeRecursos";
import { planoDoRecurso, type Recurso } from "@/lib/inbox/recursos";

const CONV = "aaaaaaaa-3333-4000-8000-000000000001";
const texto = RECURSOS[0] as unknown as Recurso;
const audio = RECURSOS[1] as unknown as Recurso;

function renderComposer(props: Record<string, unknown> = {}) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId={CONV} contactName="Ana" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue({
    data: { media_url: "https://storage.local/x.ogg?sig=1", media_mime: "audio/ogg", media_size_bytes: 1234 },
  });
});

describe("planoDoRecurso (puro)", () => {
  it("(a) recurso de TEXTO vira texto interpolado — nunca um envio", () => {
    const plano = planoDoRecurso(texto, { name: "Ana", displayName: null });
    expect(plano).toEqual({ tipo: "texto", texto: "Oi Ana, tudo bem?" });
  });

  it("(b) recurso de ÁUDIO vira anexo pendente — descreve, não envia", () => {
    const plano = planoDoRecurso(audio, { name: "Ana", displayName: null });
    expect(plano.tipo).toBe("audio");
    if (plano.tipo !== "audio") throw new Error("esperava áudio");
    expect(plano.anexo).toMatchObject({
      recursoId: "r-audio",
      titulo: "Áudio preço",
      media_path: "org/recursos/preco.ogg",
      media_mime: "audio/ogg",
    });
  });
});

describe("BarraDeRecursos", () => {
  it("um botão por título e o clique escolhe o recurso", () => {
    const onEscolher = vi.fn();
    render(<BarraDeRecursos recursos={[texto, audio]} onEscolher={onEscolher} />);
    fireEvent.click(screen.getByRole("button", { name: /boas vindas/i }));
    expect(onEscolher).toHaveBeenCalledWith(expect.objectContaining({ id: "r-texto" }));
  });
});

describe("Composer + recursos pré-prontos", () => {
  it("(a) aplicar um recurso de texto põe o texto NO CAMPO e NÃO envia sozinho", () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /boas vindas/i }));

    const campo = screen.getByLabelText(/mensagem/i);
    expect(campo).toHaveValue("Oi Ana, tudo bem?");
    // Editável: o operador ainda decide o que sai.
    expect(campo).not.toBeDisabled();
    // O critério central da issue: nenhum envio no clique.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("(b) aplicar um recurso de áudio arma o ANEXO PENDENTE; o envio só sai no clique do operador", async () => {
    renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /áudio preço/i }));

    const pendente = await screen.findByTestId("anexo-de-recurso-pendente");
    expect(pendente).toHaveTextContent(/áudio preço/i);
    // Armar não envia.
    expect(sendMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /enviar áudio/i }));

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: CONV,
        type: "audio",
        media_url: "https://storage.local/x.ogg?sig=1",
        media_mime: "audio/ogg",
      }),
      expect.anything(),
    );
  });
});
