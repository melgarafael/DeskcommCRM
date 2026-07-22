import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadMock = vi.fn(async (_args: { conversationId: string; file: File | Blob; filename?: string }) => ({
  storage_path: "org/conv/out-a.ogg",
  media_mime: "audio/ogg",
  media_size_bytes: 5,
  kind: "audio" as const,
}));
const sendMock = vi.fn();
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: uploadMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));

import { AudioRecorder } from "@/components/inbox/composer/AudioRecorder";

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = () => true;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    if (opts?.mimeType) this.mimeType = opts.mimeType;
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2])], { type: this.mimeType }) });
    this.onstop?.();
  }
}

describe("AudioRecorder", () => {
  beforeEach(() => {
    uploadMock.mockClear();
    sendMock.mockClear();
    FakeRecorder.instances = [];
    vi.stubGlobal("MediaRecorder", FakeRecorder as unknown as typeof MediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
    });
  });

  it("mic inicia gravação e mostra timer + cancelar", async () => {
    render(<AudioRecorder conversationId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: /gravar áudio/i }));
    expect(await screen.findByRole("button", { name: /cancelar gravação/i })).toBeInTheDocument();
    expect(screen.getByText(/0:0\d/)).toBeInTheDocument();
  });

  it("enviar para a gravação, sobe o blob com mime real e envia type audio", async () => {
    render(<AudioRecorder conversationId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: /gravar áudio/i }));
    await screen.findByRole("button", { name: /enviar áudio/i });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /enviar áudio/i }));
    });
    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    const arg = uploadMock.mock.calls[0]![0] as { file: Blob };
    expect(arg.file.type).toContain("audio/");
    await waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "audio", media_storage_path: "org/conv/out-a.ogg" }),
        expect.anything(),
      ),
    );
  });

  it("cancelar descarta sem upload", async () => {
    render(<AudioRecorder conversationId="conv-1" />);
    fireEvent.click(screen.getByRole("button", { name: /gravar áudio/i }));
    fireEvent.click(await screen.findByRole("button", { name: /cancelar gravação/i }));
    expect(uploadMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /gravar áudio/i })).toBeInTheDocument();
  });
});
