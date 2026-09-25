import { describe, expect, it } from "vitest";

import { MAX_FOLLOWUP_FLOW_NAME, nomeDaCopia } from "./nome-da-copia";

describe("nomeDaCopia", () => {
  it("primeira cópia ganha sufixo (cópia)", () => {
    expect(nomeDaCopia("Carrinho abandonado", [])).toBe("Carrinho abandonado (cópia)");
  });

  it("segunda cópia numera — unique (organization_id, name) não admite duas iguais", () => {
    expect(nomeDaCopia("Carrinho abandonado", ["Carrinho abandonado (cópia)"])).toBe(
      "Carrinho abandonado (cópia 2)",
    );
  });

  it("pula o número já ocupado", () => {
    expect(
      nomeDaCopia("A", ["A (cópia)", "A (cópia 2)", "A (cópia 4)"]),
    ).toBe("A (cópia 3)");
  });

  it("nunca passa de 80 caracteres, mesmo com original no teto", () => {
    const longo = "x".repeat(MAX_FOLLOWUP_FLOW_NAME);
    const nome = nomeDaCopia(longo, []);
    expect(nome.length).toBeLessThanOrEqual(MAX_FOLLOWUP_FLOW_NAME);
    expect(nome.endsWith(" (cópia)")).toBe(true);
  });

  it("cópia numerada de nome longo também cabe na coluna", () => {
    const longo = "y".repeat(MAX_FOLLOWUP_FLOW_NAME);
    const primeira = nomeDaCopia(longo, []);
    const segunda = nomeDaCopia(longo, [primeira]);
    expect(segunda.length).toBeLessThanOrEqual(MAX_FOLLOWUP_FLOW_NAME);
    expect(segunda).not.toBe(primeira);
  });
});
