import { describe, expect, it } from "vitest";

import { dataDoTimestamp } from "./ingest";

/**
 * O TIMESTAMP DO WEBHOOK NÃO PODE DERRUBAR A INGESTÃO.
 *
 * Medido em 2026-09-18: um payload com `timestamp` em NANOSSEGUNDOS fazia
 * `new Date(ns * 1000).toISOString()` lançar `RangeError: Invalid time value`,
 * e o webhook inteiro falhava. O WAHA manda segundos, mas o custo de tolerar as
 * três unidades é uma função pura — e falhar aqui perde a mensagem do cliente.
 */
const AGORA = "2026-09-18T12:00:00.000Z";

describe("dataDoTimestamp — tolera segundos, ms e ns", () => {
  it("segundos (formato do WAHA)", () => {
    expect(dataDoTimestamp(1789723200, AGORA)).toBe("2026-09-18T09:20:00.000Z");
  });

  it("milissegundos", () => {
    expect(dataDoTimestamp(1789723200000, AGORA)).toBe("2026-09-18T09:20:00.000Z");
  });

  it("nanossegundos NÃO lança (era o RangeError)", () => {
    expect(() => dataDoTimestamp(1789723200000000000, AGORA)).not.toThrow();
    expect(dataDoTimestamp(1789723200000000000, AGORA)).toBe("2026-09-18T09:20:00.000Z");
  });

  it("ausente/ inválido cai no agora — nunca lança", () => {
    expect(dataDoTimestamp(null, AGORA)).toBe(AGORA);
    expect(dataDoTimestamp(undefined, AGORA)).toBe(AGORA);
    expect(dataDoTimestamp(0, AGORA)).toBe(AGORA);
    expect(dataDoTimestamp(-5, AGORA)).toBe(AGORA);
    expect(dataDoTimestamp(Number.NaN, AGORA)).toBe(AGORA);
  });
});
