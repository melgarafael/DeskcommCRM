import { describe, expect, it } from "vitest";

import { bareWaMessageId, parseWahaMessageId } from "@/lib/waha/message-id";

describe("parseWahaMessageId", () => {
  it("string plana não é uma shape reconhecida (guard exige objeto) → null", () => {
    // NOTA: o JSDoc do parser cita 'string plana' como shape, mas o guard
    // `typeof raw !== 'object'` a rejeita. No WAHA 2026.x/NOWEB a resposta é
    // objeto ({ id: { id } }), então não nos afeta — asserção documenta o real.
    expect(parseWahaMessageId("3EB0ABC")).toBeNull();
  });
  it("WEBJS { id: { _serialized } }", () => {
    expect(parseWahaMessageId({ id: { _serialized: "true_x@c.us_3EB0" } })).toBe("true_x@c.us_3EB0");
  });
  it("NOWEB { id: { id } }", () => {
    expect(parseWahaMessageId({ id: { id: "3EB0DEF" } })).toBe("3EB0DEF");
  });
  it("NOWEB { key: { id } }", () => {
    expect(parseWahaMessageId({ key: { id: "3EB0GHI" } })).toBe("3EB0GHI");
  });
  it("shape desconhecido → null", () => {
    expect(parseWahaMessageId(42)).toBeNull();
    expect(parseWahaMessageId(null)).toBeNull();
  });
});

describe("bareWaMessageId", () => {
  it("reduz o id completo do ack (fromMe_chat@lid_bare) à cauda", () => {
    expect(bareWaMessageId("true_59782320914646@lid_3EB01851263993A0465D2D")).toBe(
      "3EB01851263993A0465D2D",
    );
  });
  it("funciona com chat @c.us", () => {
    expect(bareWaMessageId("true_5511999999999@c.us_3EB0ABC")).toBe("3EB0ABC");
  });
  it("id já-bare (sem _) passa intacto — envio grava assim", () => {
    expect(bareWaMessageId("3EB02714A82A56A80702CE")).toBe("3EB02714A82A56A80702CE");
  });
  it("cauda do ack casa com o external_id gravado no envio (invariante do fix)", () => {
    // O envio grava parseWahaMessageId(resp NOWEB { id: { id } }) = bare.
    const stored = parseWahaMessageId({ id: { id: "3EB01851263993A0465D2D" } });
    const fromAck = bareWaMessageId("true_59782320914646@lid_3EB01851263993A0465D2D");
    expect(fromAck).toBe(stored);
  });
});
