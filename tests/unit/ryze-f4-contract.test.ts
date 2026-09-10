import { describe, expect, it } from "vitest";

import {
  lerEnvelopeRyze,
  lerWebhookRyze,
  ryzeEventId,
  ryzeMessageExternalId,
  ryzeStatusDedupeKey,
} from "@/lib/channels/ryze/envelope";
import { sanitizeRyzeWebhookBody, verifyRyzeBearer } from "@/lib/channels/ryze/webhook";

describe("Ryze F4 — autenticação, envelope, sanitização e chaves", () => {
  const secret = "secret-1234567890";

  it("valida Bearer com comparação constant-time e rejeita formatos inválidos", () => {
    expect(verifyRyzeBearer(`Bearer ${secret}`, secret)).toBe(true);
    expect(verifyRyzeBearer("Bearer wrong-123456", secret)).toBe(false);
    expect(verifyRyzeBearer("Basic secret-1234567890", secret)).toBe(false);
    expect(verifyRyzeBearer("Bearer short", secret)).toBe(false);
    expect(verifyRyzeBearer("Bearer x", "x")).toBe(false);
    expect(verifyRyzeBearer(null, secret)).toBe(false);
  });

  it("aceita message.exchange com direction vindo exclusivamente de data.message", () => {
    const result = lerEnvelopeRyze(JSON.stringify({
      event: "message.exchange",
      data: {
        id: "evt-1",
        message: { id: "msg-1", direction: "incoming", text: "oi" },
        instanceData: { token: "INSTANCE_SECRET", baseUrl: "http://127.0.0.1:8080" },
      },
    }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.envelope.data.message.direction).toBe("incoming");
  });

  it("recusa direction ausente ou valores fora de incoming/outgoing", () => {
    expect(lerEnvelopeRyze(JSON.stringify({ event: "message.exchange", data: { message: { id: "m" } } })).ok).toBe(false);
    expect(lerEnvelopeRyze(JSON.stringify({ event: "message.exchange", data: { message: { direction: "inbound" } } })).ok).toBe(false);
  });

  it("faz routing de evento desconhecido para ignored sem enfraquecer o schema suportado", () => {
    expect(lerWebhookRyze(JSON.stringify({ event: "call.update", data: { arbitrary: true } }))).toEqual({
      ok: true,
      kind: "unsupported",
      event: "call.update",
    });
    expect(lerWebhookRyze(JSON.stringify({ event: "message.exchange", data: { message: {} } })).ok).toBe(false);
  });

  it("remove token e baseUrl nos shapes root e data antes de arquivar", () => {
    const raw = JSON.stringify({
      event: "message.exchange",
      data: {
        message: { direction: "incoming" },
        instanceData: { token: "NESTED_INSTANCE_SECRET", baseUrl: "http://127.0.0.1:8080" },
      },
      instanceData: { token: "ROOT_INSTANCE_SECRET", baseUrl: "http://127.0.0.1:8081", name: "inst" },
    });

    const sanitized = sanitizeRyzeWebhookBody(raw);
    expect(sanitized).not.toContain("ROOT_INSTANCE_SECRET");
    expect(sanitized).not.toContain("NESTED_INSTANCE_SECRET");
    expect(sanitized).not.toContain("127.0.0.1");
    expect(sanitized).toContain("inst");
    expect(raw).toContain("ROOT_INSTANCE_SECRET");
    expect(raw).toContain("NESTED_INSTANCE_SECRET");
  });

  it("não arquiva JSON inválido nem payload escalar cru", () => {
    expect(sanitizeRyzeWebhookBody("not-json")).toBe("[REDACTED_RYZE_INVALID_JSON_PAYLOAD]");
    expect(sanitizeRyzeWebhookBody("[1,2,3]")).toBe("[REDACTED_RYZE_NON_OBJECT_PAYLOAD]");
  });

  it("separa event id, message external id e chave de status", () => {
    const first = lerEnvelopeRyze(JSON.stringify({
      event: "message.status",
      data: { id: "delivery-1", message: { id: "msg-1", direction: "outgoing", status: "delivered" } },
    }));
    const second = lerEnvelopeRyze(JSON.stringify({
      event: "message.status",
      data: { id: "delivery-2", message: { id: "msg-1", direction: "outgoing", status: "read" } },
    }));

    expect(first.ok && ryzeEventId(first.envelope)).toBe("delivery-1");
    expect(first.ok && ryzeMessageExternalId(first.envelope)).toBe("msg-1");
    expect(first.ok && ryzeStatusDedupeKey(first.envelope)).toBe("delivery-1");
    expect(second.ok && ryzeStatusDedupeKey(second.envelope)).toBe("delivery-2");
  });
});
