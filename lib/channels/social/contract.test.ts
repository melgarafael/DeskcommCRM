import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { verifySocialWebhook, messageSchema } from "./contract";
import { SocialClient } from "./client";

describe("assinatura dos eventos sociais", () => {
  const now = 1_800_000_000_000;
  const secret = "whsec_fixture_sem_valor_real";
  const body = JSON.stringify({ id: "event-1", subaccount_id: "company-a" });
  function headers(timestamp = String(now / 1000)) {
    return new Headers({
      "webhook-id": "event-1",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${createHmac("sha256", secret).update(`event-1.${timestamp}.${body}`).digest("base64")}`,
    });
  }
  it("aceita o corpo original e recusa adulteração e outra subconta", () => {
    expect(verifySocialWebhook(body, headers(), secret, now)).toBe(true);
    expect(verifySocialWebhook(body + " ", headers(), secret, now)).toBe(false);
    expect(verifySocialWebhook(body, headers(), "whsec_outro_cliente", now)).toBe(false);
  });
  it.each(["NaN", "Infinity", "", "-1", "1800000000.5", "1799999699", "1800000301"])(
    "recusa timestamp %s",
    (ts) => {
      expect(verifySocialWebhook(body, headers(ts), secret, now)).toBe(false);
    },
  );
  it("recusa header ausente e segredo vazio", () => {
    expect(verifySocialWebhook(body, new Headers(), secret, now)).toBe(false);
    expect(verifySocialWebhook(body, headers(), "", now)).toBe(false);
  });
  it("preserva IDs opacos sem convertê-los em telefone", () => {
    const message = messageSchema.parse({
      message_id: "m1",
      channel: "instagram",
      channel_id: "c1",
      conversation_id: "thread1",
      contact_id: "p1",
      from: { external_id: "001234567890123456789" },
      type: "text",
      timestamp: now,
      content: { text: "Olá" },
    });
    expect(message.from.external_id).toBe("001234567890123456789");
  });
});

describe("cliente do HUB", () => {
  it("envia bearer só ao host fixo, com idempotência, sem header de outra conta", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message_id: "remote-1", status: "queued" }), {
        status: 202,
        headers: { "x-hub-contract-version": "1.3" },
      }),
    );
    const result = await new SocialClient("fixture", transport).send(
      "channel1",
      "00123",
      { type: "text", text: { body: "Olá" } },
      "local-message-1",
    );
    expect(result.status).toBe("queued");
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe("https://hub.sociosai.com/v1/messages");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({
      Authorization: "Bearer fixture",
      "Content-Type": "application/json",
      "Idempotency-Key": "local-message-1",
    });
    expect(JSON.parse(String(init?.body)).to).toBe("00123");
  });
  it("não aceita chave mestra de tenant como chave exclusiva da organização", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        account: { id: "a", kind: "tenant", status: "active" },
        contract_version: "1.3",
      }),
    );
    await expect(new SocialClient("fixture", transport).identity()).rejects.toThrow();
  });
  it("não propaga detalhe remoto com dados sensíveis", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code: "unauthorized", detail: "segredo" }, { status: 401 }),
      );
    await expect(new SocialClient("fixture", transport).identity()).rejects.toThrow(
      "social_api:unauthorized",
    );
  });
  it("recusa redirecionamento da conexão para host estranho", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ url: "https://outro.example/connect/x", expires_at: "2026-09-12" }),
      );
    await expect(
      new SocialClient("fixture", transport).connect("instagram", "https://crm.example"),
    ).rejects.toThrow("invalid_connect_url");
  });
  it("não confunde versão nova com sucesso", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({}, { headers: { "x-hub-contract-version": "2.0" } }));
    await expect(new SocialClient("fixture", transport).request("/v1/me")).rejects.toThrow(
      "contract_changed",
    );
  });
});
