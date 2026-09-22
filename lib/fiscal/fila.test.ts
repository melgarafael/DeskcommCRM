import { describe, expect, it } from "vitest";

import { destinoAposFalha, eRetentavel, podeTransitar, proximaTentativaEmMin } from "./fila";

describe("fila fiscal — máquina de estados", () => {
  it("backoff dobra com teto em 32 min", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(proximaTentativaEmMin)).toEqual([2, 4, 8, 16, 32, 32, 32]);
  });

  it("estados terminais não andam; erro só volta por retry", () => {
    expect(podeTransitar("autorizada", "em_emissao")).toBe(false);
    expect(podeTransitar("denegada", "em_emissao")).toBe(false);
    expect(podeTransitar("cancelada", "em_emissao")).toBe(false);
    expect(podeTransitar("erro", "em_emissao")).toBe(true);
    expect(podeTransitar("em_emissao", "autorizada")).toBe(true);
    expect(podeTransitar("em_emissao", "denegada")).toBe(true);
    expect(podeTransitar("em_emissao", "erro")).toBe(true);
    expect(podeTransitar("em_emissao", "cancelada")).toBe(true);
    expect(podeTransitar("pendente", "autorizada")).toBe(false);
  });

  it("teto de tentativas vira dead-letter em erro, não loop infinito", () => {
    expect(destinoAposFalha(1)).toEqual({ status: "pendente", esperaMin: 2 });
    expect(destinoAposFalha(4)).toEqual({ status: "pendente", esperaMin: 16 });
    expect(destinoAposFalha(5).status).toBe("erro");
    expect(destinoAposFalha(9).status).toBe("erro");
  });

  it("só falha transitória volta para a fila", () => {
    expect(eRetentavel("Sidecar fiscal inalcançável.")).toBe(true);
    expect(eRetentavel("Sidecar fiscal tempo esgotado (120s).")).toBe(true);
    expect(eRetentavel("SEFAZ/sidecar [500]: erro interno")).toBe(true);
    expect(eRetentavel("Falta CNPJ do emitente (configuração fiscal).")).toBe(false);
    expect(eRetentavel("SEFAZ/sidecar [539]: duplicidade de NF-e")).toBe(false);
    expect(eRetentavel("SEFAZ/sidecar [481]: ...")).toBe(false);
  });
});
