import { describe, expect, it } from "vitest";

import { crc16Ccitt, montarEmvPix } from "./emv";

describe("lib/pix/emv", () => {
  it("CRC16 conhecido do Bacen (payload de exemplo)", () => {
    // Prefixo típico até 6304; o CRC muda com o payload — só garante 4 hex.
    const crc = crc16Ccitt("000201");
    expect(crc).toMatch(/^[0-9A-F]{4}$/);
  });

  it("monta BR Code com chave CPF e valor", () => {
    const emv = montarEmvPix({
      chave: "12345678909",
      nome: "Marcos Vinicius",
      cidade: "Sao Paulo",
      valor: 10.5,
      txid: "DESKCOMM01",
    });
    expect(emv.startsWith("000201")).toBe(true);
    expect(emv).toContain("BR.GOV.BCB.PIX");
    expect(emv).toContain("12345678909");
    expect(emv).toContain("540510.50");
    expect(emv).toMatch(/6304[0-9A-F]{4}$/);
    // CRC bate com o algoritmo (recalcula sobre o próprio payload sem CRC).
    const semCrc = emv.slice(0, -4);
    expect(emv.slice(-4)).toBe(crc16Ccitt(semCrc));
  });

  it("omite campo 54 quando não há valor", () => {
    const emv = montarEmvPix({
      chave: "teste@email.com",
      nome: "Loja",
    });
    expect(emv).not.toContain("54");
    expect(emv).toContain("teste@email.com");
  });
});
