import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Colar imagem no composer (Ctrl/Cmd+V), padrão WhatsApp.
 *
 * A propriedade em disputa NÃO é "abre o preview" — é "abre o preview SEM
 * quebrar o Ctrl+V de texto". Um handler que intercepta cedo demais transforma
 * o campo de mensagem num campo onde colar texto não funciona, e isso é pior
 * que não ter a funcionalidade. Por isso metade destes casos prova o que o
 * handler tem que DEIXAR passar.
 */

const uploadResult = {
  storage_path: "org/conv/out-1.png",
  media_mime: "image/png",
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
import { imagemDoClipboard } from "@/lib/inbox/clipboard-image";

const CARIMBO = new Date("2026-08-07T19:26:03.000Z");

function png(nome = "image.png", bytes = [1, 2, 3], tipo = "image/png") {
  return new File([new Uint8Array(bytes)], nome, { type: tipo });
}

/** Clipboard falso: só o que o handler lê. `files`/`items` são iteráveis. */
function clipboard(opts: { files?: File[]; items?: unknown[]; texto?: string }) {
  return {
    files: opts.files ?? [],
    items:
      opts.items ??
      (opts.texto !== undefined ? [{ kind: "string", type: "text/plain", getAsFile: () => null }] : []),
    getData: () => opts.texto ?? "",
  } as unknown as DataTransfer;
}

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" {...props} />
    </QueryClientProvider>,
  );
}

const campo = () => screen.getByLabelText("Mensagem");

describe("imagemDoClipboard", () => {
  it("acha a imagem em `files` (Chrome num print de tela)", () => {
    const r = imagemDoClipboard(clipboard({ files: [png()] }), CARIMBO);
    expect(r).not.toBeNull();
    expect(r!.type).toBe("image/png");
  });

  it("acha a imagem em `items` quando `files` vem vazio (Firefox)", () => {
    const f = png();
    const dt = clipboard({ items: [{ kind: "file", type: "image/png", getAsFile: () => f }] });
    expect(imagemDoClipboard(dt, CARIMBO)).not.toBeNull();
  });

  it("devolve null para colagem de texto — é o que preserva o Ctrl+V normal", () => {
    expect(imagemDoClipboard(clipboard({ texto: "orçamento 300 mil" }), CARIMBO)).toBeNull();
  });

  it("devolve null para arquivo que não é imagem", () => {
    const pdf = new File([new Uint8Array([1])], "contrato.pdf", { type: "application/pdf" });
    expect(imagemDoClipboard(clipboard({ files: [pdf] }), CARIMBO)).toBeNull();
  });

  it("devolve null para arquivo de 0 byte em vez de subir um vazio", () => {
    expect(imagemDoClipboard(clipboard({ files: [png("image.png", [])] }), CARIMBO)).toBeNull();
  });

  it("devolve null quando não há clipboard", () => {
    expect(imagemDoClipboard(null, CARIMBO)).toBeNull();
  });

  it("batiza o print com horário — todo print chega como 'image.png'", () => {
    const r = imagemDoClipboard(clipboard({ files: [png("image.png")] }), CARIMBO);
    expect(r!.name).toBe("imagem-colada-2026-08-07-19-26-03.png");
  });

  it("preserva o nome real quando o arquivo tem um", () => {
    const r = imagemDoClipboard(clipboard({ files: [png("orcamento-final.png")] }), CARIMBO);
    expect(r!.name).toBe("orcamento-final.png");
  });

  it("entende mime com parâmetro (image/png;charset=binary)", () => {
    const r = imagemDoClipboard(clipboard({ files: [png("image.png", [1], "image/png;charset=binary")] }), CARIMBO);
    expect(r).not.toBeNull();
  });
});

describe("Composer — colar imagem", () => {
  beforeEach(() => {
    uploadMock.mockClear();
    sendMock.mockClear();
  });

  it("colar imagem abre o preview e enviar dispara upload + send", async () => {
    renderComposer();
    fireEvent.paste(campo(), { clipboardData: clipboard({ files: [png()] }) });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/legenda/i), { target: { value: "mirá esto" } });
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ conversation_id: "conv-1", type: "image", body: "mirá esto" }),
        expect.anything(),
      ),
    );
  });

  it("colar TEXTO não abre preview e não cancela o paste do browser", () => {
    renderComposer();
    const seguiu = fireEvent.paste(campo(), { clipboardData: clipboard({ texto: "bom dia" }) });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(seguiu, "preventDefault aqui quebraria o Ctrl+V de texto").toBe(true);
  });

  it("em 'Nota interna' colar imagem não vira anexo — nota é só texto", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
    const seguiu = fireEvent.paste(campo(), { clipboardData: clipboard({ files: [png()] }) });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(seguiu).toBe(true);
  });

  it("com anexo já em preview, colar não substitui em silêncio o que o operador escolheu", async () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /anexar/i }));
    const inputDoc = document.querySelector('input[accept^=".pdf"]') as HTMLInputElement;
    const doc = new File([new Uint8Array([1])], "contrato-assinado.pdf", { type: "application/pdf" });
    fireEvent.change(inputDoc, { target: { files: [doc] } });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("contrato-assinado.pdf")).toBeInTheDocument();

    fireEvent.paste(campo(), { clipboardData: clipboard({ files: [png()] }) });

    expect(screen.getByText("contrato-assinado.pdf")).toBeInTheDocument();
  });

  it("composer desabilitado ignora a colagem", () => {
    renderComposer({ disabled: true });
    fireEvent.paste(campo(), { clipboardData: clipboard({ files: [png()] }) });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// A fixture exercita um atendente autorizado a consultar modelos de mensagem.
vi.mock("@/hooks/auth/AuthProvider", () => ({ usePermission: () => true }));
