import { describe, expect, it } from "vitest";

import { ehContainerWav, embrulharPcmEmWav } from "./wav";

describe("embrulharPcmEmWav — PCM cru da ElevenLabs vira WAV sem ffmpeg", () => {
  it("escreve o cabeçalho canônico de 44 bytes: PCM, mono, 16 bits, 24 kHz", () => {
    const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80]); // 3 amostras
    const wav = embrulharPcmEmWav(pcm, 24_000);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.subarray(8, 16).toString("latin1")).toBe("WAVEfmt ");
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(28)).toBe(48_000); // bytes por segundo
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(36, 40).toString("latin1")).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    // As amostras seguem intactas depois do cabeçalho.
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it("a taxa padrão é a do `pcm_24000` que a síntese pede", () => {
    expect(embrulharPcmEmWav(Buffer.alloc(2)).readUInt32LE(24)).toBe(24_000);
  });

  it("recusa número ímpar de bytes ou áudio vazio — não é PCM de 16 bits", () => {
    expect(() => embrulharPcmEmWav(Buffer.alloc(3))).toThrow("synthesis_formato_inesperado");
    expect(() => embrulharPcmEmWav(Buffer.alloc(0))).toThrow("synthesis_formato_inesperado");
  });

  it("reconhece o WAV pelos bytes", () => {
    expect(ehContainerWav(embrulharPcmEmWav(Buffer.alloc(4)))).toBe(true);
    expect(ehContainerWav(Buffer.from("OggS\u0000\u0002\u0000\u0000\u0000\u0000\u0000\u0000"))).toBe(false);
    expect(ehContainerWav(Buffer.from("RIFF"))).toBe(false);
  });
});
