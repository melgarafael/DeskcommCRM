import { describe, expect, it } from "vitest";

import { parseWahaMessageId } from "./message-id";

/**
 * Fase 4A-3 — o external_id null nasceu de shapes de resposta do sendText que
 * o parse antigo não casava. Estes testes congelam TODOS os shapes conhecidos;
 * regressão aqui = ack do webhook volta a duplicar linha em vez de atualizar.
 */
describe("parseWahaMessageId (4A-3)", () => {
  it("id string plana", () => {
    expect(parseWahaMessageId({ id: "3EB0ABC123" })).toBe("3EB0ABC123");
  });

  it("WEBJS: id como WAMessageKey {_serialized}", () => {
    expect(
      parseWahaMessageId({ id: { fromMe: true, remote: "x@c.us", _serialized: "true_x@c.us_ABC" } }),
    ).toBe("true_x@c.us_ABC");
  });

  it("NOWEB: id aninhado {id:{id}}", () => {
    expect(parseWahaMessageId({ id: { id: "3EB0C759991E0DF28C5543" } })).toBe(
      "3EB0C759991E0DF28C5543",
    );
  });

  it("NOWEB: key {key:{id}}", () => {
    expect(parseWahaMessageId({ key: { remoteJid: "x@lid", id: "3EB0KEY" } })).toBe("3EB0KEY");
  });

  it("shapes inválidos → null (nunca lixo JSON-stringificado no external_id)", () => {
    expect(parseWahaMessageId(null)).toBeNull();
    expect(parseWahaMessageId("solto")).toBeNull();
    expect(parseWahaMessageId({})).toBeNull();
    expect(parseWahaMessageId({ id: { fromMe: true } })).toBeNull();
  });

  it("o id extraído é a MESMA string plana que o webhook de ack usa (casa a mesma linha)", () => {
    // o webhook do WAHA entrega o ack com payload.id string plana; a linha só é
    // atualizada (e não duplicada) se external_id armazenado === esse id.
    const ackWebhookId = "3EB0C759991E0DF28C5543";
    const sendTextResponse = { id: { id: ackWebhookId } }; // NOWEB
    expect(parseWahaMessageId(sendTextResponse)).toBe(ackWebhookId);
  });
});
