import { describe, expect, it } from "vitest";

import {
  identificacaoDaEntrada,
  itemEntradaSchema,
  manifestarEntradaSchema,
  ROTULO_DA_ENTRADA,
  STATUS_DA_ENTRADA,
} from "@/lib/schemas/fiscal-entrada";

describe("fiscal-entrada: contrato das notas de entrada", () => {
  it("status é vocabulário fechado com rótulo para cada um", () => {
    expect(STATUS_DA_ENTRADA).toEqual(["nova", "manifestada", "importada", "ignorada"]);
    for (const s of STATUS_DA_ENTRADA) {
      expect(ROTULO_DA_ENTRADA[s]).toBeTruthy();
    }
  });

  it("identificação mostra número/série ou 'Sem número'", () => {
    expect(identificacaoDaEntrada(123, "1")).toBe("123/1");
    expect(identificacaoDaEntrada(123, null)).toBe("123");
    expect(identificacaoDaEntrada(null, null)).toBe("Sem número");
  });

  it("manifestação só aceita os 4 eventos da SEFAZ", () => {
    expect(manifestarEntradaSchema.safeParse({ evento: "210210" }).success).toBe(true);
    expect(manifestarEntradaSchema.safeParse({ evento: "210200" }).success).toBe(true);
    expect(manifestarEntradaSchema.safeParse({ evento: "999999" }).success).toBe(false);
    expect(manifestarEntradaSchema.safeParse({}).success).toBe(false);
  });

  it("item da nota exige código, descrição e valores inteiros em centavos", () => {
    const bom = {
      codigo: "AG-5L",
      descricao: "Água Sanitária 5L",
      quantidade: 2,
      preco_cents: 5000,
      total_cents: 10000,
    };
    expect(itemEntradaSchema.safeParse(bom).success).toBe(true);
    expect(itemEntradaSchema.safeParse({ ...bom, total_cents: 100.5 }).success).toBe(false);
    expect(itemEntradaSchema.safeParse({ ...bom, codigo: undefined }).success).toBe(false);
  });
});
