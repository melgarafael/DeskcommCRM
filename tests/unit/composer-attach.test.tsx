import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadResult = {
  storage_path: "org/conv/out-1.jpg",
  media_mime: "image/jpeg",
  media_size_bytes: 3,
  kind: "image" as const,
};
const uploadMock = vi.fn(async () => uploadResult);
const sendMock = vi.fn();

vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));

import { Composer } from "@/components/inbox/Composer";
import { Button } from "@/components/ui/button";

function renderComposer() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
}

describe("Composer + anexos", () => {
  beforeEach(() => {
    uploadMock.mockClear();
    sendMock.mockClear();
  });

  // #3268: a dica do ícone de anexos. O caso mede o CONTRATO pela tela — hover
  // no botão, papel `tooltip` no DOM e o texto do rótulo — e não a leitura do
  // fonte, para que tirar o Tooltip do gatilho deixe o caso vermelho.
  it("passar o mouse no ícone de anexos mostra a dica com o rótulo daquele ícone", async () => {
    const user = userEvent.setup();
    renderComposer();
    // Sem ponteiro não há balão: a dica nasce do hover, não do render.
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await user.hover(screen.getByRole("button", { name: /anexar/i }));

    const dica = await screen.findByRole("tooltip", {}, { timeout: 2000 });
    expect(dica).toHaveTextContent("Anexar");
    // Rótulo DAQUELE ícone: a dica do emoji não vaza para cá.
    expect(dica).not.toHaveTextContent("Emoji");
  });

  it("a dica não acrescenta caixa na linha de ações (mesma altura)", () => {
    renderComposer();
    const botao = screen.getByRole("button", { name: /anexar/i });
    // jsdom não calcula layout: o que dá para afirmar é o que DECIDE a altura —
    // (1) o botão segue filho DIRETO da linha (`flex items-end gap-2`), ou seja,
    // Provider/Tooltip/Trigger não inseriram nó nenhum na fileira; (2) a classe
    // do botão é a MESMA de um Button size="icon" sem Tooltip — comparada
    // inteira, e não por um pedaço como "h-9", que segue presente quando alguém
    // força um tamanho fixo e tira o alvo de 44px do toque.
    expect(botao.parentElement?.className).toContain("items-end");
    const { getByRole } = render(
      <Button type="button" size="icon" variant="ghost" className="shrink-0" aria-label="referência" />,
    );
    expect(botao.className).toBe(getByRole("button", { name: "referência" }).className);
    // E o balão fechado não ocupa lugar nenhum no lugar do ícone.
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("botão Anexar abre o menu com as duas opções", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    expect(screen.getByText("Fotos e vídeos")).toBeInTheDocument();
    expect(screen.getByText("Documento")).toBeInTheDocument();
  });

  it("selecionar arquivo abre preview e enviar dispara upload + send com caption", async () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    const input = document.querySelector('input[accept^="image"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "foto.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/legenda/i), { target: { value: "olha isso" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation_id: "conv-1",
          type: "image",
          body: "olha isso",
          media_storage_path: "org/conv/out-1.jpg",
          media_mime: "image/jpeg",
          media_size_bytes: 3,
        }),
        expect.anything(),
      ),
    );
  });

  it("upload falho mantém o dialog aberto (sem disparar send)", async () => {
    uploadMock.mockRejectedValueOnce(new Error("upload_failed"));
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    const input = document.querySelector('input[accept^="image"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "foto.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

// A fixture exercita um atendente autorizado a consultar modelos de mensagem.
vi.mock("@/hooks/auth/AuthProvider", () => ({
  usePermission: () => true,
  // A escolha de contato do Composer lê o país da organização (o exemplo do telefone); sem organização, o Brasil.
  usePaisDaOrgAtiva: () => null,
}));
