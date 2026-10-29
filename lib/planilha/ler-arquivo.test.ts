import { describe, expect, it } from "vitest";

import { IMPORT_MAX_DATA_ROWS, parseImportFile } from "@/lib/planilha/ler-arquivo";

function csv(texto: string): ArrayBuffer {
  const b = new TextEncoder().encode(texto);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe("parseImportFile — teto de linhas", () => {
  it("respeita maxLinhas e diz o teto efetivo na mensagem", async () => {
    const r = await parseImportFile(csv("empresa;telefone\nA;1\nB;2\nC;3\n"), "lista.csv", {
      maxLinhas: 2,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("2");
  });

  it("aceita exatamente maxLinhas linhas de dados", async () => {
    const r = await parseImportFile(csv("empresa;telefone\nA;1\nB;2\n"), "lista.csv", {
      maxLinhas: 2,
    });
    expect(r.ok).toBe(true);
  });

  it("sem opções o teto continua sendo o de 2.000 linhas", async () => {
    const corpo = (n: number) =>
      "empresa;telefone\n" + Array.from({ length: n }, (_, i) => `E${i};${i}`).join("\n") + "\n";
    expect(IMPORT_MAX_DATA_ROWS).toBe(2_000);
    expect((await parseImportFile(csv(corpo(2_000)), "lista.csv")).ok).toBe(true);
    const r = await parseImportFile(csv(corpo(2_001)), "lista.csv");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("2000");
  });
});

describe("parseImportFile — formato", () => {
  it("recusa .txt", async () => {
    const r = await parseImportFile(csv("empresa;telefone\nA;1\n"), "lista.txt");
    expect(r).toEqual({ ok: false, error: "Formato não suportado — envie .csv ou .xlsx." });
  });
});
