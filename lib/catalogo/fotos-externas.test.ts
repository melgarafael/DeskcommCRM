import { describe, expect, it } from "vitest";

import { fotoPertenceAoProduto } from "./fotos";
import { trazerFotosParaOArmazenamento, uuidDaFotoExterna, type DepsDasFotos } from "./fotos-externas";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROD = "22222222-2222-4222-8222-222222222222";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function deps(conteudo: Record<string, Uint8Array | null>, subidas: string[] = []): DepsDasFotos {
  return {
    async baixar(url) {
      return conteudo[url] ?? null;
    },
    async subir(caminho) {
      subidas.push(caminho);
      return true;
    },
  };
}

describe("trazerFotosParaOArmazenamento", () => {
  it("troca cada link pela foto no bucket, na mesma posição, num caminho que o agente aceita", async () => {
    const subidas: string[] = [];
    const r = await trazerFotosParaOArmazenamento(
      deps({ "https://cdn/1.jpg": JPEG, "https://cdn/2.png": PNG }, subidas),
      { orgId: ORG, produtoId: PROD, fotos: ["https://cdn/1.jpg", "https://cdn/2.png"] },
    );
    expect(r.baixadas).toBe(2);
    expect(r.fotos[0]).toBe(`${ORG}/${PROD}/${uuidDaFotoExterna("https://cdn/1.jpg")}.jpg`);
    expect(r.fotos[1]).toMatch(/\.png$/);
    expect(r.fotos.every((f) => fotoPertenceAoProduto(f, ORG, PROD))).toBe(true);
    expect(subidas).toEqual(r.fotos);
  });

  it("foto já do bucket fica; link que falha ou que não é JPG/PNG continua como link", async () => {
    const nossa = `${ORG}/${PROD}/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jpg`;
    const r = await trazerFotosParaOArmazenamento(deps({ "https://cdn/webp": WEBP }), {
      orgId: ORG,
      produtoId: PROD,
      fotos: [nossa, "https://cdn/fora-do-ar.jpg", "https://cdn/webp"],
    });
    expect(r.fotos).toEqual([nossa, "https://cdn/fora-do-ar.jpg", "https://cdn/webp"]);
    expect(r).toMatchObject({ baixadas: 0, falhas: 2 });
  });

  it("reimportar não duplica: link de foto já trazida sai da lista", async () => {
    const trazida = `${ORG}/${PROD}/${uuidDaFotoExterna("https://cdn/1.jpg")}.jpg`;
    const subidas: string[] = [];
    const r = await trazerFotosParaOArmazenamento(deps({ "https://cdn/1.jpg": JPEG }, subidas), {
      orgId: ORG,
      produtoId: PROD,
      fotos: [trazida, "https://cdn/1.jpg"],
    });
    expect(r.fotos).toEqual([trazida]);
    expect(subidas).toEqual([]);
  });

  it("o mesmo link sempre cai no mesmo arquivo", () => {
    expect(uuidDaFotoExterna("https://cdn/1.jpg")).toBe(uuidDaFotoExterna(" https://cdn/1.jpg "));
    expect(uuidDaFotoExterna("https://cdn/1.jpg")).not.toBe(uuidDaFotoExterna("https://cdn/2.jpg"));
  });
});
