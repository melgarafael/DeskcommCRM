import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
