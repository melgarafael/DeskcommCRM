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
  CONVERSOES_POR_ORGANIZACAO,
  ENTRADA_ACEITA,
  CONVERSOES_SIMULTANEAS,
  ConversorOcupado,
  VOICE_MIME,
  TETO_REPRODUCAO_BYTES,
  paraReproducaoAac,
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

  it("imagem e documento não são assunto daqui", () => {
    expect(precisaTranscodificar("image/jpeg")).toBe(false);
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

/**
 * F2 (ADR-0006): o iPhone grava `audio/mp4` (AAC) — o Safari anterior ao 18.4
 * não grava webm nem ogg. O WAHA converte sozinho, mas os canais oficiais só
 * aceitam opus como nota de voz. Por isso, QUANDO o arquivo é uma nota de voz
 * do gravador (`notaDeVoz`), tudo que não é ogg vira opus. Sem a marca, um m4a
 * enviado por token segue intacto: uma música não pode virar opus mono de 24k.
 */
describe("nota de voz gravada no iPhone (F2)", () => {
  it("com notaDeVoz, mp4/aac/m4a precisam converter; sem a marca, não", () => {
    for (const m of ["audio/mp4", "audio/aac", "audio/x-m4a", "audio/mp4;codecs=mp4a.40.2"]) {
      expect(precisaTranscodificar(m, true), m).toBe(true);
      expect(precisaTranscodificar(m), m).toBe(false);
    }
  });

  it("com notaDeVoz, ogg continua sem conversão — já é o destino", () => {
    expect(precisaTranscodificar("audio/ogg;codecs=opus", true)).toBe(false);
  });

  it("com notaDeVoz, o que não é áudio não vira ffmpeg à toa", () => {
    expect(precisaTranscodificar("application/pdf", true)).toBe(false);
    expect(precisaTranscodificar("image/jpeg", true)).toBe(false);
  });

  it("AAC é REENCODADO em opus mono 24k: copiar o container não serve para AAC", async () => {
    const run = vi.fn(async (args: string[], _cwd: string) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[args.length - 1]!, Buffer.from("ogg-opus"));
    });
    const r = await transcodificarNotaDeVoz(
      { buffer: Buffer.from("m4a"), mime: "audio/mp4", notaDeVoz: true },
      { run },
    );
    const args = run.mock.calls[0]?.[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(["-c:a", "libopus", "-b:a", "24k", "-ac", "1", "-ar", "48000"]));
    expect(args).not.toContain("copy");
    expect(r).toMatchObject({ convertido: true, mime: VOICE_MIME });
    expect(r.buffer.toString()).toBe("ogg-opus");
  });

  it("webm com notaDeVoz continua trocando só o container", async () => {
    const run = vi.fn(async (_args: string[], _cwd: string) => {});
    await transcodificarNotaDeVoz({ ...webm, notaDeVoz: true }, { run });
    expect(run.mock.calls[0]?.[0]).toContain("copy");
  });

  it("ffmpeg falhando no AAC devolve o original — o WAHA segue convertendo sozinho", async () => {
    const run = vi.fn(async () => {
      throw new Error("ffmpeg_exit_1");
    });
    const entrada = { buffer: Buffer.from("m4a"), mime: "audio/mp4", notaDeVoz: true };
    const r = await transcodificarNotaDeVoz(entrada, { run });
    expect(r).toMatchObject({ convertido: false, mime: "audio/mp4" });
    expect(r.buffer).toBe(entrada.buffer);
  });

  it("a rota de upload lê a marca com Zod e a repassa", () => {
    const fonte = readFileSync("app/api/v1/conversations/[id]/media/route.ts", "utf8");
    expect(fonte).toMatch(/z\.literal\("1"\)/);
    expect(fonte).toMatch(/transcodificarNotaDeVoz\(\{[^}]*notaDeVoz/);
  });
});

/**
 * F2: o Safari do iPhone (antes do 18.4) não toca ogg/opus. Para tocar, o
 * servidor converte NA HORA para AAC em MP4 e não guarda nada — a cópia
 * derivada escaparia do expurgo e da anonimização.
 */
/** A lista de formatos aceitos vem inteira e antes do `-i`; depois dele ela não vale para a entrada. */
function listaAntesDaEntrada(args: string[]): void {
  const i = args.indexOf("-i");
  expect(i).toBeGreaterThan(0);
  const antes = args.slice(0, i);
  for (let k = 0; k < ENTRADA_ACEITA.length; k += 2) {
    const flag = ENTRADA_ACEITA[k]!;
    expect(antes, `${flag} antes do -i`).toContain(flag);
    expect(antes[antes.indexOf(flag) + 1]).toBe(ENTRADA_ACEITA[k + 1]);
  }
}

describe("o ffmpeg só lê os formatos de áudio esperados", () => {
  it("nota de voz e conversão para tocar passam a lista antes do -i", async () => {
    const run = vi.fn(async (args: string[], _cwd: string) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[args.length - 1]!, Buffer.from("x"));
    });
    await transcodificarNotaDeVoz({ buffer: Buffer.from("m4a"), mime: "audio/mp4", notaDeVoz: true }, { run });
    await paraReproducaoAac(Buffer.from("ogg"), "org-lista", { run });
    expect(run).toHaveBeenCalledTimes(2);
    for (const [args] of run.mock.calls) listaAntesDaEntrada(args);
  });
});

describe("paraReproducaoAac", () => {
  it("converte para AAC em MP4 com faststart e devolve os bytes", async () => {
    const run = vi.fn(async (args: string[], _cwd: string) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[args.length - 1]!, Buffer.from("mp4-aac"));
    });
    const r = await paraReproducaoAac(Buffer.from("ogg"), "org-a", { run });
    const args = run.mock.calls[0]?.[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(["-vn", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-f", "mp4"]));
    expect(r.toString()).toBe("mp4-aac");
  });

  it("recusa entrada acima do teto sem chamar o ffmpeg", async () => {
    const run = vi.fn(async () => {});
    await expect(paraReproducaoAac(Buffer.alloc(TETO_REPRODUCAO_BYTES + 1), "org-a", { run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("ffmpeg falhando REJEITA — quem chama responde 502, não devolve o ogg intocável", async () => {
    const run = vi.fn(async () => {
      throw new Error("ffmpeg_exit_1");
    });
    await expect(paraReproducaoAac(Buffer.from("ogg"), "org-a", { run })).rejects.toThrow();
  });

  it("acima de CONVERSOES_SIMULTANEAS no processo recusa com ConversorOcupado, e a vaga volta ao terminar", async () => {
    const soltar: Array<() => void> = [];
    const run = vi.fn(
      (args: string[], _cwd: string) =>
        new Promise<void>((resolve) => {
          soltar.push(async () => {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(args[args.length - 1]!, Buffer.from("mp4"));
            resolve();
          });
        }),
    );
    const emCurso = Array.from({ length: CONVERSOES_SIMULTANEAS }, (_, i) => paraReproducaoAac(Buffer.from("ogg"), `org-${i}`, { run }));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(CONVERSOES_SIMULTANEAS));

    await expect(paraReproducaoAac(Buffer.from("ogg"), "org-outra", { run })).rejects.toBeInstanceOf(ConversorOcupado);
    expect(run).toHaveBeenCalledTimes(CONVERSOES_SIMULTANEAS);

    for (const s of soltar) s();
    await Promise.all(emCurso);
    // A vaga volta mesmo quando o ffmpeg falha.
    await expect(
      paraReproducaoAac(Buffer.from("ogg"), "org-0", { run: async () => { throw new Error("ffmpeg_exit_1"); } }),
    ).rejects.toThrow("ffmpeg_exit_1");
    const depois = vi.fn(async (args: string[], _cwd: string) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[args.length - 1]!, Buffer.from("mp4"));
    });
    await expect(paraReproducaoAac(Buffer.from("ogg"), "org-0", { run: depois })).resolves.toBeInstanceOf(Buffer);
  });

  it("uma organização não ocupa sozinha as vagas: a segunda dela espera e a de outra entra", async () => {
    expect(CONVERSOES_POR_ORGANIZACAO).toBeLessThan(CONVERSOES_SIMULTANEAS);
    let soltar: () => void = () => {};
    const presa = vi.fn(
      (args: string[], _cwd: string) =>
        new Promise<void>((resolve) => {
          soltar = async () => {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(args[args.length - 1]!, Buffer.from("mp4"));
            resolve();
          };
        }),
    );
    const daA = paraReproducaoAac(Buffer.from("ogg"), "org-a", { run: presa });
    await vi.waitFor(() => expect(presa).toHaveBeenCalledTimes(1));

    const livre = vi.fn(async (args: string[], _cwd: string) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[args.length - 1]!, Buffer.from("mp4"));
    });
    await expect(paraReproducaoAac(Buffer.from("ogg"), "org-a", { run: livre })).rejects.toBeInstanceOf(ConversorOcupado);
    await expect(paraReproducaoAac(Buffer.from("ogg"), "org-b", { run: livre })).resolves.toBeInstanceOf(Buffer);

    soltar();
    await daA;
    // A vaga da organização volta ao terminar.
    await expect(paraReproducaoAac(Buffer.from("ogg"), "org-a", { run: livre })).resolves.toBeInstanceOf(Buffer);
  });

  it("saída vazia também rejeita", async () => {
    const run = vi.fn(async (args: string[], _cwd: string) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[args.length - 1]!, Buffer.alloc(0));
    });
    await expect(paraReproducaoAac(Buffer.from("ogg"), "org-a", { run })).rejects.toThrow();
  });
});
