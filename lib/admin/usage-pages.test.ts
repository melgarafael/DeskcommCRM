import { describe, expect, it } from "vitest";
import { lerPaginasDeUso } from "./usage-pages";

describe("uso completo acima do teto PostgREST", () => {
  it("lê 1501 linhas sem repetir nem truncar", async () => {
    const linhas = Array.from({ length: 1501 }, (_, i) => ({
      id: String(i).padStart(6, "0"),
      custo: 1,
    }));
    let chamadas = 0;
    const todas = await lerPaginasDeUso(async (depois, tamanho) => {
      chamadas++;
      return {
        data: linhas
          .filter((l) => depois === null || l.id > depois)
          .slice(0, Math.min(tamanho, 1000)),
        error: null,
      };
    });
    expect(todas).toHaveLength(1501);
    expect(new Set(todas.map((l) => l.id)).size).toBe(1501);
    expect(chamadas).toBe(5);
  });
  it("falha em vez de apresentar total parcial quando a segunda página falha", async () => {
    await expect(
      lerPaginasDeUso(async (depois) =>
        depois === null
          ? {
              data: Array.from({ length: 500 }, (_, i) => ({ id: String(i).padStart(6, "0") })),
              error: null,
            }
          : { data: null, error: { code: "timeout" } },
      ),
    ).rejects.toThrow("usage_page_failed");
  });
  it("recusa cursor repetido", async () => {
    await expect(
      lerPaginasDeUso(async () => ({
        data: Array.from({ length: 500 }, () => ({ id: "igual" })),
        error: null,
      })),
    ).rejects.toThrow("usage_cursor_stalled");
  });
});

it("continua se o servidor limita páginas a menos de 500", async () => {
  const rows = Array.from({ length: 251 }, (_, i) => ({ id: String(i).padStart(6, "0") }));
  const all = await lerPaginasDeUso(async (after) => ({
    data: rows.filter((r) => after === null || r.id > after).slice(0, 100),
    error: null,
  }));
  expect(all).toHaveLength(251);
});
