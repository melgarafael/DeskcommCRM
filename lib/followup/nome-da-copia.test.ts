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
    expect(nomeDaCopia("A", ["A (cópia)", "A (cópia 2)", "A (cópia 4)"])).toBe("A (cópia 3)");
  });

  it("nunca passa de 80 caracteres, mesmo com original no teto", () => {
    const longo = "x".repeat(MAX_FOLLOWUP_FLOW_NAME);
    const nome = nomeDaCopia(longo, []);
    expect(nome.length).toBeLessThanOrEqual(MAX_FOLLOWUP_FLOW_NAME);
    expect(nome.endsWith(" (cópia)")).toBe(true);
  });

  it("nome que já é cópia continua a linhagem — não empilha sufixo", () => {
    expect(
      nomeDaCopia("Carrinho abandonado (cópia)", [
        "Carrinho abandonado",
        "Carrinho abandonado (cópia)",
      ]),
    ).toBe("Carrinho abandonado (cópia 2)");
  });

  it("teto configurável: a mesma régua serve o agente, cujo nome vai até 120", () => {
    const longo = "x".repeat(120);
    const nome = nomeDaCopia(longo, [], { teto: 120 });
    expect(nome.length).toBe(120);
    expect(nome.endsWith(" (cópia)")).toBe(true);
    const segunda = nomeDaCopia(nome, [nome], { teto: 120 });
    expect(segunda.length).toBe(120);
    expect(segunda.endsWith(" (cópia 2)")).toBe(true);
  });

  it("o corte no teto não parte um emoji ao meio", () => {
    // 111 + o emoji (2 unidades UTF-16) + " (cópia)" (8) = 121 > 120: o corte cai
    // no meio do emoji. Meia letra é JSON que o Postgres recusa no INSERT.
    const nome = nomeDaCopia("a".repeat(111) + "😀", [], { teto: 120 });
    expect(nome).toBe("a".repeat(111) + " (cópia)");
  });

  it("original vazio no follow-up continua virando Fluxo (cópia)", () => {
    expect(nomeDaCopia("   ", [])).toBe("Fluxo (cópia)");
  });

  it("cópia numerada de nome longo também cabe na coluna", () => {
    const longo = "y".repeat(MAX_FOLLOWUP_FLOW_NAME);
    const primeira = nomeDaCopia(longo, []);
    const segunda = nomeDaCopia(longo, [primeira]);
    expect(segunda.length).toBeLessThanOrEqual(MAX_FOLLOWUP_FLOW_NAME);
    expect(segunda).not.toBe(primeira);
  });
});
