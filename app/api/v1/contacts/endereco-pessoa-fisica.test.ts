/**
 * Endereço da pessoa física no contato (#3494).
 *
 * Entrega e cobrança dependem de CEP/logradouro/UF; antes só existia
 * `address_book_name` (nome na agenda), que não serve para nenhuma das duas.
 *
 * O schema é a porta de entrada: o que ele recusar nunca chega ao insert, e o
 * que ele aceitar tem de sobreviver até a linha. Estes testes fixam os dois
 * lados — o endereço completo passa, e os limites de campo continuam de pé
 * (UF de 2 letras, CEP de até 16 caracteres).
 */
import { describe, expect, it } from "vitest";

import { contactCreateSchema } from "@/lib/schemas/contacts";

const enderecoCompleto = {
  name: "Ana Souza",
  zip_code: "80000-000",
  street: "Rua das Araucárias",
  number: "120",
  complement: "apto 42",
  district: "Centro",
  city: "Curitiba",
  state: "PR",
};

describe("endereço da pessoa física no contato (#3494)", () => {
  it("aceita o endereço completo de entrega e cobrança", () => {
    const r = contactCreateSchema.safeParse(enderecoCompleto);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.zip_code).toBe("80000-000");
      expect(r.data.city).toBe("Curitiba");
      expect(r.data.state).toBe("PR");
    }
  });

  it("recusa UF com mais de duas letras", () => {
    const r = contactCreateSchema.safeParse({ ...enderecoCompleto, state: "PAR" });
    expect(r.success).toBe(false);
  });

  it("recusa CEP maior que o limite da coluna", () => {
    const r = contactCreateSchema.safeParse({ ...enderecoCompleto, zip_code: "1".repeat(17) });
    expect(r.success).toBe(false);
  });

  it("aceita contato SEM endereço — os campos são opcionais", () => {
    const r = contactCreateSchema.safeParse({ name: "Sem endereço" });
    expect(r.success).toBe(true);
  });

  it("aceita endereço parcial (só cidade e UF)", () => {
    const r = contactCreateSchema.safeParse({ name: "Parcial", city: "Araucária", state: "PR" });
    expect(r.success).toBe(true);
  });
});
