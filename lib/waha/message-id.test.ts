import { describe, expect, it } from "vitest";

import { wahaEchoExternalIds, parseWahaMessageId } from "./message-id";

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

/**
 * AS FORMAS DO ECO DO NOSSO ENVIO — uma regra, dois escritores.
 *
 * O envio normal (`app/api/v1/messages/_handler.ts`, via
 * `wahaAdapter.echoExternalIds`) e o reenvio do watchdog
 * (`lib/agent-engine/edge/crm/session-reconciler.ts`) apagam o eco que o webhook
 * gravou antes de o id chegar. Os dois precisam procurar as MESMAS formas: se
 * divergirem, o eco some por um caminho e fica pelo outro — que é como a
 * duplicata "voltava".
 */
describe("wahaEchoExternalIds", () => {
  it("NOWEB: o envio devolve o id cru e o eco chega composto — as duas formas entram", () => {
    expect(wahaEchoExternalIds("3EB0ABC123", "5511900000002@c.us")).toEqual([
      "3EB0ABC123",
      "true_5511900000002@c.us_3EB0ABC123",
    ]);
  });

  it("contato @lid: o composto é montado com o chat @lid, que é o que o engine grava", () => {
    // Payload real de eco, o mesmo documentado em `chatIdFromWaMessageId`.
    const ecoDoWebhook = "true_250302204792918@lid_2A1B890FB8AA87730CBC";
    expect(wahaEchoExternalIds("2A1B890FB8AA87730CBC", "250302204792918@lid")).toContain(
      ecoDoWebhook,
    );
  });

  it("WEBJS: os dois lados usam o serializado — ele entra, junto da cauda, sem repetir", () => {
    expect(
      wahaEchoExternalIds("true_5511900000002@c.us_3EB0ABC123", "5511900000002@c.us"),
    ).toEqual(["true_5511900000002@c.us_3EB0ABC123", "3EB0ABC123"]);
  });
});
