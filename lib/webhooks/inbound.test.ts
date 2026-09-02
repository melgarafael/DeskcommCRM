import { describe, it, expect } from "vitest";
import { mapInboundPayload, normalizePhoneNumber, verifyInboundSignature } from "@/lib/webhooks/inbound";
import { createHmac } from "node:crypto";

describe("normalizePhoneNumber", () => {
  it("já em E.164 passa direto", () => expect(normalizePhoneNumber("+258841234567")).toBe("+258841234567"));
  it("número moçambicano de 9 dígitos ganha +258", () =>
    expect(normalizePhoneNumber("84 123 4567")).toBe("+258841234567"));
  it("com 258 na frente sem +", () => expect(normalizePhoneNumber("258841234567")).toBe("+258841234567"));
  it("DDD+numero BR (legado) ganha +55", () => expect(normalizePhoneNumber("11 99876-5432")).toBe("+5511998765432"));
  it("com 55 na frente sem + (legado)", () => expect(normalizePhoneNumber("5511998765432")).toBe("+5511998765432"));
  it("fixo BR 10 dígitos (legado)", () => expect(normalizePhoneNumber("1133334444")).toBe("+551133334444"));
  it("lixo → null", () => expect(normalizePhoneNumber("abc")).toBeNull());
  it("vazio/não-string → null", () => {
    expect(normalizePhoneNumber("")).toBeNull();
    expect(normalizePhoneNumber(42 as unknown)).toBeNull();
  });
});

describe("mapInboundPayload", () => {
  it("aliases default: nome/telefone/email", () => {
    const m = mapInboundPayload({ nome: "Ana", telefone: "11998765432", email: "a@b.com" });
    expect(m).toMatchObject({ name: "Ana", phone: "+5511998765432", email: "a@b.com" });
  });
  it("whatsapp como alias de phone; extras viram custom_fields; utm_* vira source_metadata", () => {
    const m = mapInboundPayload({ name: "Bo", whatsapp: "+5511998765432", empresa: "ACME", utm_source: "instagram" });
    expect(m.phone).toBe("+5511998765432");
    expect(m.custom_fields).toEqual({ empresa: "ACME" });
    expect(m.source_metadata).toEqual({ utm_source: "instagram" });
  });
  it("field_map custom tem precedência sobre defaults", () => {
    const m = mapInboundPayload({ contato: "Zé" }, { name: ["contato"] });
    expect(m.name).toBe("Zé");
  });
  it("payload sem nada mapeável → tudo null e extras preservados", () => {
    const m = mapInboundPayload({ foo: "bar" });
    expect(m.name).toBeNull();
    expect(m.phone).toBeNull();
    expect(m.custom_fields).toEqual({ foo: "bar" });
  });
  it("valores não-string são stringificados em custom_fields; objetos aninhados descartados", () => {
    const m = mapInboundPayload({ nome: "Ana", idade: 30, nested: { a: 1 } });
    expect(m.custom_fields).toEqual({ idade: "30" });
  });
});

describe("verifyInboundSignature", () => {
  const body = '{"nome":"Ana"}';
  const secret = "s3cr3t";
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  it("assinatura válida", () => expect(verifyInboundSignature(body, sig, secret)).toBe(true));
  it("assinatura errada", () => expect(verifyInboundSignature(body, "deadbeef", secret)).toBe(false));
  it("header ausente", () => expect(verifyInboundSignature(body, null, secret)).toBe(false));
  it("header com tamanho diferente não lança (timingSafeEqual exige mesmo length)", () =>
    expect(verifyInboundSignature(body, "abc", secret)).toBe(false));
});
