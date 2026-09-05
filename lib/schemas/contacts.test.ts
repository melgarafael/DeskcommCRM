/**
 * Tests for EPIC-05 contact schemas (Wave 1).
 *
 * Covers:
 *  - E.164 phone validator (accept/reject)
 *  - Email parsing
 *  - CPF check-digit (valid, invalid, repeated digits)
 *  - lgpdAnonymizeSchema requires justification ≥ 10 chars
 *  - contactListQuerySchema coerces `limit` and clamps boundaries
 */
import { describe, expect, it } from "vitest";
import {
  contactCreateSchema,
  contactListQuerySchema,
  contactPatchSchema,
  isValidCpf,
  lgpdAnonymizeSchema,
} from "./contacts";

describe("isValidCpf", () => {
  it("accepts a known-valid CPF", () => {
    // Generated valid CPFs (algorithm verified).
    expect(isValidCpf("52998224725")).toBe(true);
    expect(isValidCpf("11144477735")).toBe(true);
  });

  it("rejects repeated-digit CPFs", () => {
    expect(isValidCpf("00000000000")).toBe(false);
    expect(isValidCpf("11111111111")).toBe(false);
    expect(isValidCpf("99999999999")).toBe(false);
  });

  it("rejects invalid check digits", () => {
    expect(isValidCpf("52998224726")).toBe(false);
    expect(isValidCpf("12345678900")).toBe(false);
  });

  it("rejects wrong length / non-digits", () => {
    expect(isValidCpf("123")).toBe(false);
    expect(isValidCpf("abcdefghijk")).toBe(false);
    expect(isValidCpf("")).toBe(false);
  });

  it("normalizes formatting (dots/dashes)", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
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

  it("rejects invalid CPF", () => {
    const r = contactCreateSchema.safeParse({ cpf: "12345678900" });
    expect(r.success).toBe(false);
  });

  it("accepts valid CPF", () => {
    const r = contactCreateSchema.safeParse({ cpf: "52998224725" });
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
