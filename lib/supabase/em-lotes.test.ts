import { describe, expect, it } from "vitest";
import { IDS_POR_LOTE, buscaEmLotes } from "./em-lotes";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("buscaEmLotes", () => {
  it("lista vazia não consulta nada", async () => {
    let chamadas = 0;
    const r = await buscaEmLotes([], async () => {
      chamadas++;
      return { data: [], error: null };
    });
    expect(r).toEqual({ data: [], error: null });
    expect(chamadas).toBe(0);
  });

  it("nenhum lote passa do teto e todos os ids chegam, na ordem", async () => {
    // 415: o funil real que parou de abrir.
    const vistos: string[][] = [];
    const r = await buscaEmLotes(ids(415), async (lote) => {
      vistos.push(lote);
      return { data: lote, error: null };
    });
    expect(vistos.every((l) => l.length <= IDS_POR_LOTE)).toBe(true);
    expect(vistos).toHaveLength(Math.ceil(415 / IDS_POR_LOTE));
    expect(r.data).toEqual(ids(415));
    expect(r.error).toBeNull();
  });

  it("com orçamento de bytes, o lote fecha pelo tamanho codificado na URL, não pela contagem", async () => {
    // id de mensagem do WhatsApp: ~70 B por candidato depois de codificado.
    const longos = Array.from({ length: 300 }, (_, i) => `false_5511900000001@s.whatsapp.net_3A${i}${"F".repeat(34)}`);
    const vistos: string[][] = [];
    const r = await buscaEmLotes(
      longos,
      async (lote) => {
        vistos.push(lote);
        return { data: lote, error: null };
      },
      { bytesPorLote: 2000 },
    );
    expect(vistos.length).toBeGreaterThan(1);
    for (const l of vistos) {
      expect(l.length).toBeLessThanOrEqual(IDS_POR_LOTE);
      expect(l.map((x) => encodeURIComponent(`"${x}",`).length).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2000);
    }
    expect(r.data).toEqual(longos);
  });

  it("erro em qualquer lote vira erro do todo, não resultado parcial", async () => {
    const r = await buscaEmLotes(ids(250), async (lote) =>
      lote[0] === `id-${IDS_POR_LOTE}`
        ? { data: null, error: { message: "fetch failed" } }
        : { data: lote, error: null },
    );
    expect(r).toEqual({ data: [], error: { message: "fetch failed" } });
  });
});
