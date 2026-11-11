import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const ingerirSmsRecebido = vi.fn();
vi.mock("@/lib/channels/sms/ingest", () => ({
  ingerirSmsRecebido: (...a: unknown[]) => ingerirSmsRecebido(...a),
}));

import { acceptsInboundWebhook, handleInboundWebhook, verifyInboundWebhookSignature } from "@/lib/channels/inbound";

// Montados em pedaços: o literal inteiro tem a forma de id real e o scanner
// de segredos do GitHub recusa o push. São falsos.
const CONTA = "AC" + "0123456789abcdef".repeat(2);
const CHAVE = "chave-falsa-" + "x".repeat(20);
const URL_PUBLICA = "https://crm.exemplo.com/api/v1/webhooks/channel/tok12345";

const FORM = {
  MessageSid: "SM" + "a".repeat(32),
  AccountSid: CONTA,
  From: "+14155550100",
  To: "+14155550199",
  Body: "Can you send a quote?",
  NumMedia: "0",
};

/** O mesmo algoritmo de `assinaturaDoSmsValida`, já conferido contra a biblioteca oficial. */
function assinar(chave: string, url: string, params: Record<string, string>): string {
  const conteudo = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", chave).update(conteudo, "utf8").digest("base64");
}

function headers(assinatura: string | null): Headers {
  const h = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (assinatura) h.set("x-twilio-signature", assinatura);
  return h;
}

/** Admin falso: só a leitura da sessão que o handler faz. */
function adminComSessao(sessao: { twilio_account_sid: string | null; phone_number: string | null } | null) {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    maybeSingle: async () => ({ data: sessao, error: null }),
  };
  return { from: vi.fn(() => cadeia) } as never;
}

const SESSAO = { id: "sess-1", organization_id: "org-1", provider: "twilio" };
const rawBody = new URLSearchParams(FORM).toString();

describe("entrada do SMS", () => {
  beforeEach(() => {
    ingerirSmsRecebido.mockReset();
    ingerirSmsRecebido.mockResolvedValue({ status: "ingested", conversationId: "conv-1", messageId: "msg-1" });
  });

  it("a rota genérica aceita o canal de SMS", () => {
    expect(acceptsInboundWebhook("twilio")).toBe(true);
  });

  it("assinatura certa passa; sem URL, URL diferente ou corpo mexido não passa", () => {
    const sig = assinar(CHAVE, URL_PUBLICA, FORM);
    expect(verifyInboundWebhookSignature("twilio", rawBody, headers(sig), CHAVE, URL_PUBLICA)).toBe(true);
    expect(verifyInboundWebhookSignature("twilio", rawBody, headers(sig), CHAVE, null)).toBe(false);
    expect(verifyInboundWebhookSignature("twilio", rawBody, headers(sig), CHAVE, URL_PUBLICA + "x")).toBe(false);
    const mexido = new URLSearchParams({ ...FORM, Body: "outra coisa" }).toString();
    expect(verifyInboundWebhookSignature("twilio", mexido, headers(sig), CHAVE, URL_PUBLICA)).toBe(false);
    expect(verifyInboundWebhookSignature("twilio", rawBody, headers(null), CHAVE, URL_PUBLICA)).toBe(false);
  });

  it("SMS desta conta e deste número vai para a ingestão com o telefone de quem mandou", async () => {
    const r = await handleInboundWebhook(adminComSessao({ twilio_account_sid: CONTA, phone_number: "+14155550199" }), {
      session: SESSAO,
      rawBody,
      headers: headers(assinar(CHAVE, URL_PUBLICA, FORM)),
      secret: CHAVE,
      urlPublica: URL_PUBLICA,
    });
    expect(r).toEqual({ ok: true, body: { status: "ingested", conversationId: "conv-1", messageId: "msg-1" } });
    expect(ingerirSmsRecebido).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      sms: expect.objectContaining({ de: "+14155550100", para: "+14155550199", texto: "Can you send a quote?" }),
    });
  });

  it("assinatura ruim é 401 e não grava nada", async () => {
    const r = await handleInboundWebhook(adminComSessao({ twilio_account_sid: CONTA, phone_number: "+14155550199" }), {
      session: SESSAO,
      rawBody,
      headers: headers("assinatura-falsa"),
      secret: CHAVE,
      urlPublica: URL_PUBLICA,
    });
    expect(r).toMatchObject({ ok: false, code: "unauthorized" });
    expect(ingerirSmsRecebido).not.toHaveBeenCalled();
  });

  it("outra conta ou outro número da mesma conta são ignorados", async () => {
    const entrada = {
      session: SESSAO,
      rawBody,
      headers: headers(assinar(CHAVE, URL_PUBLICA, FORM)),
      secret: CHAVE,
      urlPublica: URL_PUBLICA,
    };
    const outraConta = await handleInboundWebhook(
      adminComSessao({ twilio_account_sid: "AC" + "f".repeat(32), phone_number: "+14155550199" }),
      entrada,
    );
    expect(outraConta).toEqual({ ok: true, body: { status: "ignored", reason: "outra_conta" } });
    const outroNumero = await handleInboundWebhook(
      adminComSessao({ twilio_account_sid: CONTA, phone_number: "+14155550111" }),
      entrada,
    );
    expect(outroNumero).toEqual({ ok: true, body: { status: "ignored", reason: "outro_numero" } });
    expect(ingerirSmsRecebido).not.toHaveBeenCalled();
  });

  it("formulário fora do contrato é recusado com os campos culpados", async () => {
    const torto = { ...FORM, From: "nao-e-telefone" };
    const r = await handleInboundWebhook(adminComSessao({ twilio_account_sid: CONTA, phone_number: "+14155550199" }), {
      session: SESSAO,
      rawBody: new URLSearchParams(torto).toString(),
      headers: headers(assinar(CHAVE, URL_PUBLICA, torto)),
      secret: CHAVE,
      urlPublica: URL_PUBLICA,
    });
    expect(r).toMatchObject({ ok: false, code: "contrato_violado", message: expect.stringContaining("From") });
    expect(ingerirSmsRecebido).not.toHaveBeenCalled();
  });
});
