/**
 * Tests for EPIC-05 contact schemas (Wave 1).
 *
 * Covers:
 *  - E.164 phone validator (accept/reject)
 *  - Email parsing
 *  - NIF de forma (BI angolano e numérico puro — sem dígito verificador)
 *  - lgpdAnonymizeSchema requires justification ≥ 10 chars
 *  - contactListQuerySchema coerces `limit` and clamps boundaries
 */
import { describe, expect, it } from "vitest";
import {
  contactCreateSchema,
  contactListQuerySchema,
  contactPatchSchema,
  isValidNif,
  lgpdAnonymizeSchema,
} from "./contacts";

describe("isValidNif", () => {
  it("accepts o formato BI (9 dígitos + 2 letras de província + 3 dígitos)", () => {
    expect(isValidNif("003862011LA042")).toBe(true);
    // letras minúsculas normalizam — o BI impresso não distingue caixa.
    expect(isValidNif("003862011la042")).toBe(true);
  });

  it("accepts NIF puramente numérico (empresa ou estrangeiro sem BI)", () => {
    expect(isValidNif("541712345")).toBe(true); // 9 dígitos
    expect(isValidNif("5417123456")).toBe(true); // 10 dígitos
  });

  it("rejects forma errada", () => {
    expect(isValidNif("123")).toBe(false); // curto demais para as duas formas
    expect(isValidNif("54171234567")).toBe(false); // 11 dígitos — nem BI nem numérico (era CPF)
    expect(isValidNif("00386201LA0042")).toBe(false); // letras na posição errada
    expect(isValidNif("abcdefghijk")).toBe(false);
    expect(isValidNif("")).toBe(false);
  });

  it("não valida dígito verificador — é checagem de FORMA, de propósito", () => {
    // Não há algoritmo público de dígito verificador do NIF angolano documentado;
    // qualquer string na forma certa passa. Ver o comentário de `isValidNif`.
    expect(isValidNif("999999999AA999")).toBe(true);
  });
});

describe("contactCreateSchema", () => {
  it("accepts minimal valid payload (defaults source=manual)", () => {
    const parsed = contactCreateSchema.parse({ name: "Ana" });
    expect(parsed.source).toBe("manual");
  });

  it("rejects non-E.164 phones", () => {
    const r = contactCreateSchema.safeParse({ phone_number: "11999998888" });
    expect(r.success).toBe(false);
  });

  it("accepts E.164 phones", () => {
    const r = contactCreateSchema.safeParse({ phone_number: "+5511999998888" });
    expect(r.success).toBe(true);
  });

  it("rejects malformed emails", () => {
    const r = contactCreateSchema.safeParse({ email: "not-an-email" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid NIF", () => {
    const r = contactCreateSchema.safeParse({ cpf: "12345678900" }); // 11 dígitos: nem BI nem numérico
    expect(r.success).toBe(false);
  });

  it("accepts valid NIF", () => {
    const r = contactCreateSchema.safeParse({ cpf: "003862011LA042" });
    expect(r.success).toBe(true);
  });

  it("rejects malformed birthdate", () => {
    const r = contactCreateSchema.safeParse({ birthdate: "01/01/1990" });
    expect(r.success).toBe(false);
  });

  it("aceita campos personalizados como objeto JSON", () => {
    const r = contactCreateSchema.safeParse({
      custom_fields: { segmento: "vip", score: 10, consentiu: true },
    });
    expect(r.success).toBe(true);
  });

  it("recusa campos personalizados acima de 32 KB", () => {
    // O CHECK do banco só garante que é OBJETO. Sem teto de tamanho, um cliente
    // da API escreveria megabytes numa coluna que a listagem de contatos traz
    // inteira — e o custo apareceria como "a tela ficou lenta", longe da causa.
    const r = contactCreateSchema.safeParse({
      custom_fields: { observacao: "x".repeat(33_000) },
    });
    expect(r.success).toBe(false);
  });

  it("recusa chave vazia em campos personalizados", () => {
    const r = contactCreateSchema.safeParse({ custom_fields: { "": "valor" } });
    expect(r.success).toBe(false);
  });
});

describe("contactPatchSchema", () => {
  it("não materializa source=manual quando PATCH omite source", () => {
    const parsed = contactPatchSchema.parse({ tags: ["vip"] });

    expect(parsed).toEqual({ tags: ["vip"] });
    expect("source" in parsed).toBe(false);
  });
});

describe("contactListQuerySchema", () => {
  it("defaults limit to 50", () => {
    const r = contactListQuerySchema.parse({});
    expect(r.limit).toBe(50);
  });

  it("coerces limit string", () => {
    const r = contactListQuerySchema.parse({ limit: "25" });
    expect(r.limit).toBe(25);
  });

  it("rejects limit > 100", () => {
    const r = contactListQuerySchema.safeParse({ limit: "500" });
    expect(r.success).toBe(false);
  });

  it("defaults order_by and order_dir", () => {
    const r = contactListQuerySchema.parse({});
    expect(r.order_by).toBe("last_activity_at");
    expect(r.order_dir).toBe("desc");
  });

  it("accepts valid order_by", () => {
    const r = contactListQuerySchema.parse({ order_by: "display_name", order_dir: "asc" });
    expect(r.order_by).toBe("display_name");
    expect(r.order_dir).toBe("asc");
  });
});

describe("lgpdAnonymizeSchema", () => {
  it("requires justification with at least 10 chars", () => {
    const r = lgpdAnonymizeSchema.safeParse({
      contact_id: "00000000-0000-0000-0000-000000000000",
      justification: "curto",
    });
    expect(r.success).toBe(false);
  });

  it("requires uuid contact_id", () => {
    const r = lgpdAnonymizeSchema.safeParse({
      contact_id: "not-a-uuid",
      justification: "Solicitação formal LGPD do titular.",
    });
    expect(r.success).toBe(false);
  });

  it("accepts well-formed payload", () => {
    const r = lgpdAnonymizeSchema.safeParse({
      contact_id: "11111111-1111-4111-8111-111111111111",
      justification: "Solicitação formal LGPD do titular do dado.",
    });
    expect(r.success).toBe(true);
  });
});
