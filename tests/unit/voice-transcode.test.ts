import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

/**
 * Nota de voz gravada no browser → o formato que o WhatsApp aceita.
 *
 * ─── O defeito, medido em produção ──────────────────────────────────────────
 *
 * O `MediaRecorder` do Chrome não sabe gravar `audio/ogg`: aceita o pedido, cai
 * no fallback `audio/webm;codecs=opus`, e o canal oficial recusa DEPOIS de
 * aceitar o envio —
 *
 *   131053 Media upload error — "Make sure the media URL is publicly
 *   accessible and in a supported format."
 *
 * A mensagem culpa a URL, e a URL estava certa: `webm` não está na lista de
 * formatos aceitos (MP3, OGG, AMR, AAC). O operador vê "falhou" numa nota de
 * voz que gravou normalmente.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Que a conversão aconteça só quando precisa, que ela não seja um caminho
 * frágil (falhar devolve o original, nunca derruba o upload), e que o mime
 * DEVOLVIDO seja o do arquivo guardado — devolver o original mandaria o canal
 * buscar um `webm` que já não existe, que é o mesmo defeito um passo adiante.
 */
import { extFromMime } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import {
  VOICE_MIME,
  precisaTranscodificar,
  transcodificarNotaDeVoz,
} from "@/lib/messaging/media/voice-transcode";

const webm = { buffer: Buffer.from("webm-bytes"), mime: "audio/webm;codecs=opus" };

describe("quando precisa converter", () => {
  it("webm do browser precisa — é o que o Chrome grava", () => {
    expect(precisaTranscodificar("audio/webm;codecs=opus")).toBe(true);
    expect(precisaTranscodificar("audio/webm")).toBe(true);
  });

  it("ogg NÃO precisa — já é o formato de destino", () => {
    expect(precisaTranscodificar("audio/ogg;codecs=opus")).toBe(false);
    expect(precisaTranscodificar("audio/ogg")).toBe(false);
  });

  it("mp3, aac e amr passam intactos — a plataforma os aceita", () => {
    for (const m of ["audio/mpeg", "audio/aac", "audio/amr"]) {
      expect(precisaTranscodificar(m)).toBe(false);
    }
  });

  it("imagem, vídeo e documento não são assunto daqui", () => {
    expect(precisaTranscodificar("image/jpeg")).toBe(false);
    expect(precisaTranscodificar("video/webm")).toBe(false);
    expect(precisaTranscodificar("video/mp4")).toBe(false);
    expect(precisaTranscodificar("application/pdf")).toBe(false);
  });
});

describe("a conversão", () => {
  it("devolve ogg quando dá certo", async () => {
    // Tipado com os args reais: o teste lê o 1º, e `async () => {}` o esconde.
    const run = vi.fn(async (_args: string[], _cwd: string) => {});
    // O dublê de ffmpeg não escreve arquivo, então o read falha e cai no
    // caminho de erro — que é justamente o próximo caso. Aqui o que importa é
    // que ffmpeg SEJA chamado com os argumentos certos.
    await transcodificarNotaDeVoz(webm, { run });
    expect(run).toHaveBeenCalled();
    const args = run.mock.calls[0]?.[0] ?? [];
    // `-c:a copy`: o codec já é opus dos dois lados; o que muda é o container.
    // Reencodar custaria tempo e qualidade para chegar ao mesmo lugar.
    expect(args).toContain("copy");
    expect(args).toContain("ogg");
  });

  it("NÃO chama ffmpeg quando não precisa — conversão à toa é custo puro", async () => {
    const run = vi.fn(async () => {});
    const r = await transcodificarNotaDeVoz(
      { buffer: Buffer.from("ogg"), mime: "audio/ogg" },
      { run },
    );
    expect(run).not.toHaveBeenCalled();
    expect(r.convertido).toBe(false);
    expect(r.mime).toBe("audio/ogg");
  });

  it("ffmpeg falhando devolve o ORIGINAL, não erro", async () => {
    // Um áudio que talvez não saia é melhor que um envio que morre antes de
    // tentar — e o canal que converte sozinho continua funcionando como sempre.
    const run = vi.fn(async () => {
      throw new Error("ffmpeg_exit_1");
    });
    const r = await transcodificarNotaDeVoz(webm, { run });
    expect(r.convertido).toBe(false);
    expect(r.buffer).toBe(webm.buffer);
    expect(r.mime).toBe(webm.mime);
  });

  it("arquivo grande demais passa intacto em vez de travar o upload", async () => {
    const run = vi.fn(async () => {});
    const grande = { buffer: Buffer.alloc(17 * 1024 * 1024), mime: "audio/webm" };
    const r = await transcodificarNotaDeVoz(grande, { run });
    expect(run).not.toHaveBeenCalled();
    expect(r.convertido).toBe(false);
  });

  it("o destino é o mime que a plataforma aceita — COM o codec", () => {
    // `base audio/ogg not supported` está na doc do canal oficial. Sem o
    // `codecs=opus` o Storage serve o Content-Type que a plataforma recusa, e o
    // 131053 volta — só que agora culpando um arquivo que está certo.
    expect(VOICE_MIME).toBe("audio/ogg;codecs=opus");
  });

  it("o mime de destino continua rendendo a extensão e a categoria certas", () => {
    // O `;codecs=opus` passa por dois pontos que cortam no `;`. Se um deles
    // deixar de cortar, o arquivo vira `.bin` no bucket ou perde a categoria
    // `audio` — e a nota de voz sai como documento.
    expect(extFromMime(VOICE_MIME)).toBe("ogg");
    expect(validateOutboundMedia(VOICE_MIME, 1024)).toEqual({ ok: true, kind: "audio" });
  });
});

describe("o elo que some sem barulho", () => {
  it("a rota de upload converte ANTES de guardar", () => {
    // Converter no envio faria a mesma gravação ser transcodificada por
    // destinatário, e deixaria guardado um formato que só um canal aceita.
    const fonte = readFileSync("app/api/v1/conversations/[id]/media/route.ts", "utf8");
    expect(fonte).toContain("transcodificarNotaDeVoz");
    expect(fonte).toMatch(/upload\(storagePath,\s*buffer,\s*\{\s*contentType:\s*mimeFinal/);
  });

  it("devolve o mime do arquivo GUARDADO, não o que chegou", () => {
    // Devolver o original mandaria o canal buscar um `webm` que já não existe —
    // o mesmo defeito, um passo adiante.
    const fonte = readFileSync("app/api/v1/conversations/[id]/media/route.ts", "utf8");
    expect(fonte).toMatch(/media_mime:\s*mimeFinal/);
    expect(fonte).toMatch(/media_size_bytes:\s*buffer\.length/);
  });
});
