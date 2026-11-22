/**
 * O ARQUIVO DA PRIMEIRA ABORDAGEM QUE ENTRA PELA TELA (#4751).
 *
 * A prova que interessa não é "a rota devolveu um caminho": é que o caminho que
 * a tela grava na configuração é o MESMO que o worker assina no envio. Por isso
 * o último caso pega o descritor que a rota produz e o entrega a
 * `prepararMidiaDaAbordagem` — a função do worker — conferindo o bucket e o
 * `storage_path` exatos que ela pede ao Storage.
 *
 * O resto são as duas pontas que a rota não pode errar: o tipo sai dos BYTES
 * (áudio e zip não passam, mesmo com `content-type` mentindo) e o teto por tipo
 * é o da régua do envio, não um número novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { isMediaPathInOrganization } from "@/lib/messaging/media/upload-validation";
import {
  caminhoDoArquivoDaAbordagem,
  descreverArquivoDaAbordagem,
  farejarArquivoDaAbordagem,
} from "@/lib/prospecting/arquivo-da-abordagem";
import {
  BUCKET_DA_MIDIA_DA_CAMPANHA,
  prepararMidiaDaAbordagem,
  VALIDADE_DA_URL_DA_MIDIA_S,
} from "@/lib/prospecting/midia-da-abordagem";

const ORG = "0b110000-0000-4000-8000-000000000001";
const OUTRA_ORG = "0b110000-0000-4000-8000-000000000002";
const ARQUIVO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function bytesDe(prefixo: readonly number[], tamanho = 32): Uint8Array {
  const bytes = new Uint8Array(tamanho);
  bytes.set(prefixo, 0);
  return bytes;
}

function asciiEm(texto: string, inicio: number, tamanho = 32): Uint8Array {
  const bytes = new Uint8Array(tamanho);
  for (let i = 0; i < texto.length; i += 1) bytes[inicio + i] = texto.charCodeAt(i);
  return bytes;
}

/** A caixa `ftyp` de um vídeo: tamanho, `ftyp`, marca, versão. */
function video(marca: string, tamanho = 64): Uint8Array {
  const bytes = asciiEm(`\x00\x00\x00\x18ftyp${marca}\x00\x00\x00\x00`, 0, tamanho);
  return bytes;
}

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n");
const PNG = bytesDe([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = bytesDe([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = asciiEm("RIFF\x00\x00\x00\x00WEBP", 0);
const OGG = asciiEm("OggS", 0);
const MP3 = asciiEm("ID3", 0);
const ZIP = bytesDe([0x50, 0x4b, 0x03, 0x04]);

describe("o tipo do arquivo sai dos bytes", () => {
  it("aceita os três tipos da abordagem, com o mime certo em cada container de vídeo", () => {
    expect(farejarArquivoDaAbordagem(PDF)).toBe("application/pdf");
    expect(farejarArquivoDaAbordagem(PNG)).toBe("image/png");
    expect(farejarArquivoDaAbordagem(JPEG)).toBe("image/jpeg");
    expect(farejarArquivoDaAbordagem(WEBP)).toBe("image/webp");
    expect(farejarArquivoDaAbordagem(video("isom"))).toBe("video/mp4");
    expect(farejarArquivoDaAbordagem(video("mp42"))).toBe("video/mp4");
    expect(farejarArquivoDaAbordagem(video("3gp4"))).toBe("video/3gpp");
    expect(farejarArquivoDaAbordagem(video("qt  "))).toBe("video/quicktime");
  });

  it("recusa áudio e arquivo genérico, que a abordagem fria não manda", () => {
    expect(farejarArquivoDaAbordagem(OGG)).toBeNull();
    expect(farejarArquivoDaAbordagem(MP3)).toBeNull();
    expect(farejarArquivoDaAbordagem(ZIP)).toBeNull();
    expect(farejarArquivoDaAbordagem(video("xxxx"))).toBeNull();
  });
});

describe("o caminho do arquivo é o do bucket que o worker lê", () => {
  it("grava sob {org}/prospecting/ com a extensão do tipo farejado", () => {
    expect(caminhoDoArquivoDaAbordagem(ORG, ARQUIVO, "application/pdf")).toBe(
      `${ORG}/prospecting/${ARQUIVO}.pdf`,
    );
    expect(caminhoDoArquivoDaAbordagem(ORG, ARQUIVO, "video/quicktime")).toBe(
      `${ORG}/prospecting/${ARQUIVO}.mov`,
    );
    // Mime fora da lista não vira caminho nenhum.
    expect(caminhoDoArquivoDaAbordagem(ORG, ARQUIVO, "audio/ogg")).toBeNull();
  });

  it("é um caminho DESTA organização para `validateConfig`", () => {
    const caminho = caminhoDoArquivoDaAbordagem(ORG, ARQUIVO, "application/pdf")!;
    expect(isMediaPathInOrganization(caminho, ORG)).toBe(true);
    expect(isMediaPathInOrganization(caminho, OUTRA_ORG)).toBe(false);
  });

  it("o descritor é o caminho, o mime farejado e o tamanho dos bytes", () => {
    const descrito = descreverArquivoDaAbordagem({ organizationId: ORG, id: ARQUIVO, bytes: PDF });
    expect(descrito).toEqual({
      ok: true,
      midia: {
        storage_path: `${ORG}/prospecting/${ARQUIVO}.pdf`,
        media_mime: "application/pdf",
        media_size_bytes: PDF.length,
      },
    });
  });
});

describe("a régua do tamanho é a do envio", () => {
  it("recusa imagem acima de 5 MB sem inventar caminho", () => {
    const grande = new Uint8Array(5 * 1024 * 1024 + 1);
    grande.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const descrito = descreverArquivoDaAbordagem({ organizationId: ORG, id: ARQUIVO, bytes: grande });
    expect(descrito.ok).toBe(false);
    if (!descrito.ok) expect(descrito.codigo).toBe("validation_failed");
  });

  it("recusa o que não é imagem, vídeo ou PDF com o código de tipo", () => {
    const descrito = descreverArquivoDaAbordagem({ organizationId: ORG, id: ARQUIVO, bytes: OGG });
    expect(descrito.ok).toBe(false);
    if (!descrito.ok) expect(descrito.codigo).toBe("unsupported_media_type");
  });
});

describe("o caminho do upload é o que o worker assina", () => {
  it("`prepararMidiaDaAbordagem` pede esse storage_path no bucket da campanha", async () => {
    const descrito = descreverArquivoDaAbordagem({ organizationId: ORG, id: ARQUIVO, bytes: PDF });
    expect(descrito.ok).toBe(true);
    if (!descrito.ok) return;

    const pedidos: { bucket: string; path: string; ttl: number }[] = [];
    const admin = {
      storage: {
        from(bucket: string) {
          return {
            createSignedUrl: async (path: string, ttl: number) => {
              pedidos.push({ bucket, path, ttl });
              return { data: { signedUrl: "https://storage.local/assinada" }, error: null };
            },
          };
        },
      },
    } as unknown as SupabaseClient;

    const pronta = await prepararMidiaDaAbordagem(admin, descrito.midia);

    expect(pronta).toEqual({
      ok: true,
      tipo: "document",
      mime: "application/pdf",
      url: "https://storage.local/assinada",
    });
    expect(pedidos).toEqual([
      {
        bucket: BUCKET_DA_MIDIA_DA_CAMPANHA,
        path: descrito.midia.storage_path,
        ttl: VALIDADE_DA_URL_DA_MIDIA_S,
      },
    ]);
    expect(BUCKET_DA_MIDIA_DA_CAMPANHA).toBe("whatsapp-media");
  });
});
