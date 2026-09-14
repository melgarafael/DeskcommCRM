import { describe, expect, it } from "vitest";

import { erroDeConflitoDeProcesso, processoConstaNoResumo, processoLinkBodySchema } from "./processo-links";

describe("vínculos de processo Advomax", () => {
  it("aceita somente códigos inteiros positivos", () => {
    expect(processoLinkBodySchema.safeParse({ processo_codigo: "42" }).success).toBe(true);
    expect(processoLinkBodySchema.safeParse({ processo_codigo: 0 }).success).toBe(false);
    expect(processoLinkBodySchema.safeParse({ processo_codigo: 1.5 }).success).toBe(false);
  });

  it("reconhece o processo somente no resumo jurídico válido", () => {
    expect(processoConstaNoResumo([{ codigo: 42 }], 42)).toBe(true);
    expect(processoConstaNoResumo([{ codigo: 42 }], 7)).toBe(false);
    expect(processoConstaNoResumo([{ codigo: "invalido" }], 42)).toBe(false);
  });

  it("classifica colisão única como conflito", () => {
    expect(erroDeConflitoDeProcesso({ code: "23505" })).toBe(true);
    expect(erroDeConflitoDeProcesso({ code: "42501" })).toBe(false);
  });
});
