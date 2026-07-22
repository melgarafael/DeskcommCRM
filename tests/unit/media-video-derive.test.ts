import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveVideoText } from "@/lib/messaging/media/video-derive";

// Evita tocar o filesystem real / ffmpeg: mocka fs/promises usado pelo módulo.
// vi.hoisted p/ o factory (hoisted) alcançar as refs.
const { files, fsMock } = vi.hoisted(() => {
  const files: Record<string, Buffer> = {};
  const fsMock = {
    mkdtemp: vi.fn(async () => "/tmp/vid-derive-test"),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async (p: string) => files[p.split("/").pop()!] ?? Buffer.from([0])),
    readdir: vi.fn(async () => Object.keys(files).filter((f) => f.startsWith("frame-"))),
    rm: vi.fn(async () => undefined),
  };
  return { files, fsMock };
});
vi.mock("node:fs/promises", () => ({ ...fsMock, default: fsMock }));

function deps(over: Partial<Parameters<typeof deriveVideoText>[1]> = {}) {
  return {
    transcriber: { transcribe: vi.fn(async () => "olá quero comprar o produto") },
    describeImage: vi.fn(async () => "pessoa segurando um tênis vermelho"),
    // runFfmpeg fake: "cria" audio.ogg + 2 frames no mapa de arquivos.
    runFfmpeg: vi.fn(async (args: string[]) => {
      if (args.includes("audio.ogg")) files["audio.ogg"] = Buffer.from([1, 2, 3]);
      else {
        files["frame-01.jpg"] = Buffer.from([1]);
        files["frame-02.jpg"] = Buffer.from([2]);
      }
    }),
    ...over,
  };
}

afterEach(() => {
  for (const k of Object.keys(files)) delete files[k];
});

describe("deriveVideoText", () => {
  it("combina transcrição do áudio + descrição dos frames", async () => {
    const out = await deriveVideoText(Buffer.from([9]), deps());
    expect(out).toContain("Transcrição do áudio do vídeo: olá quero comprar o produto");
    expect(out).toContain("Cenas do vídeo:");
    expect(out).toContain("Quadro 1: pessoa segurando um tênis vermelho");
  });

  it("vídeo SEM áudio → só as cenas (transcrição vazia não quebra)", async () => {
    const d = deps({
      runFfmpeg: vi.fn(async (args: string[]) => {
        if (args.includes("audio.ogg")) throw new Error("no audio stream");
        files["frame-01.jpg"] = Buffer.from([1]);
      }),
    });
    const out = await deriveVideoText(Buffer.from([9]), d);
    expect(out).not.toContain("Transcrição");
    expect(out).toContain("Cenas do vídeo:");
  });

  it("limpa o diretório temporário mesmo se a visão falhar", async () => {
    const d = deps({ describeImage: vi.fn(async () => { throw new Error("vision down"); }) });
    const out = await deriveVideoText(Buffer.from([9]), d);
    // frames falharam → só transcrição sobra; e o rm foi chamado (cleanup).
    expect(out).toContain("Transcrição do áudio");
    expect(fsMock.rm).toHaveBeenCalled();
  });
});
