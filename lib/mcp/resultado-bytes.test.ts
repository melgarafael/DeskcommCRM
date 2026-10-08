import { describe, expect, it } from "vitest";

import { tamanhoDoResultado } from "./resultado-bytes";

describe("tamanhoDoResultado", () => {
  it("conta os bytes do JSON que volta ao modelo", () => {
    expect(tamanhoDoResultado({ a: 1 })).toBe(Buffer.byteLength('{"a":1}', "utf8"));
    expect(tamanhoDoResultado([])).toBe(2);
  });

  it("conta bytes, não caracteres: acento e emoji pesam mais de 1", () => {
    const texto = { n: "João 😀" };
    expect(tamanhoDoResultado(texto)).toBe(Buffer.byteLength(JSON.stringify(texto), "utf8"));
    expect(tamanhoDoResultado(texto)!).toBeGreaterThan(JSON.stringify(texto).length);
  });

  it("resultado que não dá para medir devolve undefined, nunca lança", () => {
    const circular: Record<string, unknown> = {};
    circular.eu = circular;
    expect(tamanhoDoResultado(circular)).toBeUndefined();
    expect(tamanhoDoResultado({ n: 10n })).toBeUndefined();
    expect(tamanhoDoResultado(undefined)).toBeUndefined();
  });
});
