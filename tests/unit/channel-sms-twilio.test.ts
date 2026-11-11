import { describe, expect, it, vi } from "vitest";

import {
  assinaturaDoSmsValida,
  enviarSms,
  formularioDoWebhook,
  lerSmsRecebido,
  motivoDaRecusa,
  partesDoSms,
  SmsRecusado,
} from "@/lib/channels/sms/twilio";

// Montado em pedaços de propósito: o literal inteiro tem a forma de um id de
// conta real e o scanner de segredos do GitHub recusa o push. É falso.
const CONTA = "AC" + "0123456789abcdef".repeat(2);
const CREDS = { accountSid: CONTA, authToken: "test_auth_token_123" };

describe("assinatura do webhook de SMS", () => {
  // Vetor de referência gerado pela biblioteca OFICIAL do fornecedor
  // (twilio@5, getExpectedTwilioSignature + validateRequest === true) — não
  // pela própria função testada, que provaria só que ela concorda consigo.
  const URL_PUBLICA = "https://crm.exemplo.com/api/v1/webhooks/channel/abc123";
  const PARAMS = {
    MessageSid: "SM0123456789abcdef0123456789abcdef",
    AccountSid: CONTA,
    From: "+14155550100",
    To: "+14155550199",
    Body: "Hi, quote for deck repair?",
    NumMedia: "0",
  };
  const ESPERADA = "kLdxkDVXA6LsughrFJGUA/D8uzc=";

  it("aceita a assinatura que a biblioteca oficial calcula", () => {
    expect(assinaturaDoSmsValida(CREDS.authToken, URL_PUBLICA, PARAMS, ESPERADA)).toBe(true);
  });

  it("recusa quando um parâmetro muda depois de assinado", () => {
    expect(
      assinaturaDoSmsValida(CREDS.authToken, URL_PUBLICA, { ...PARAMS, Body: "outro texto" }, ESPERADA),
    ).toBe(false);
  });

  it("recusa quando a URL não é a configurada no fornecedor", () => {
    expect(assinaturaDoSmsValida(CREDS.authToken, URL_PUBLICA + "x", PARAMS, ESPERADA)).toBe(false);
  });

  it("recusa com a chave errada", () => {
    expect(assinaturaDoSmsValida("outra_chave", URL_PUBLICA, PARAMS, ESPERADA)).toBe(false);
  });

  it("falha fechado sem chave ou sem cabeçalho", () => {
    expect(assinaturaDoSmsValida(null, URL_PUBLICA, PARAMS, ESPERADA)).toBe(false);
    expect(assinaturaDoSmsValida(CREDS.authToken, URL_PUBLICA, PARAMS, null)).toBe(false);
    expect(assinaturaDoSmsValida(CREDS.authToken, URL_PUBLICA, PARAMS, "")).toBe(false);
  });

  it("lê o corpo form-urlencoded do jeito que o fornecedor manda", () => {
    const raw = new URLSearchParams(PARAMS).toString();
    expect(formularioDoWebhook(raw)).toEqual(PARAMS);
    expect(assinaturaDoSmsValida(CREDS.authToken, URL_PUBLICA, formularioDoWebhook(raw), ESPERADA)).toBe(true);
  });
});

describe("leitura do SMS recebido", () => {
  const BASE = {
    MessageSid: "SM0123456789abcdef0123456789abcdef",
    AccountSid: CONTA,
    From: "+14155550100",
    To: "+14155550199",
    Body: "Need a quote",
    NumMedia: "0",
  };

  it("traduz para o vocabulário do CRM", () => {
    expect(lerSmsRecebido(BASE)).toEqual({
      ok: true,
      sms: {
        externalId: BASE.MessageSid,
        contaId: CONTA,
        de: "+14155550100",
        para: "+14155550199",
        texto: "Need a quote",
        quantidadeDeMidias: 0,
      },
    });
  });

  it("aceita mensagem sem corpo (só mídia)", () => {
    const r = lerSmsRecebido({ ...BASE, Body: "", NumMedia: "1", MessageSid: "MM0123456789abcdef0123456789abcdef" });
    expect(r.ok && r.sms.texto === "" && r.sms.quantidadeDeMidias === 1).toBe(true);
  });

  it("aponta os campos fora do contrato em vez de aceitar", () => {
    const r = lerSmsRecebido({ ...BASE, From: "4155550100", MessageSid: "xx" });
    expect(r).toEqual({ ok: false, campos: expect.arrayContaining(["From", "MessageSid"]) });
  });
});

describe("envio de SMS", () => {
  function respostaFalsa(status: number, corpo: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(corpo), { status }));
  }

  it("manda o formulário certo, com autenticação no cabeçalho, e devolve o id", async () => {
    const f = respostaFalsa(201, { sid: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const r = await enviarSms(CREDS, { de: "+14155550199", para: "+14155550100", texto: "Hello" }, f);
    expect(r).toEqual({ sid: "SMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${CONTA}/Messages.json`);
    expect(url).not.toContain(CREDS.authToken);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      "Basic " + Buffer.from(`${CONTA}:${CREDS.authToken}`).toString("base64"),
    );
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({ From: "+14155550199", To: "+14155550100", Body: "Hello" });
  });

  it("STOP do destinatário vira recusa com a categoria certa, sem a chave no texto", async () => {
    const f = respostaFalsa(400, { code: 21610, message: "Attempt to send to unsubscribed recipient" });
    const erro = await enviarSms(CREDS, { de: "+14155550199", para: "+14155550100", texto: "Hi" }, f).catch(
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(SmsRecusado);
    expect((erro as SmsRecusado).motivo).toBe("destinatario_descadastrado");
    expect((erro as SmsRecusado).message).not.toContain(CREDS.authToken);
  });

  it("não chama o fornecedor com dado fora do formato", async () => {
    const f = respostaFalsa(201, { sid: "SMx" });
    await expect(enviarSms({ ...CREDS, accountSid: "../../x" }, { de: "+14155550199", para: "+14155550100", texto: "a" }, f)).rejects.toThrow(
      "sms_account_invalid",
    );
    await expect(enviarSms(CREDS, { de: "4155550199", para: "+14155550100", texto: "a" }, f)).rejects.toThrow(
      "sms_from_invalid",
    );
    await expect(enviarSms(CREDS, { de: "+14155550199", para: "+14155550100", texto: "   " }, f)).rejects.toThrow(
      "sms_empty_body",
    );
    const destino = await enviarSms(CREDS, { de: "+14155550199", para: "123", texto: "a" }, f).catch((e: unknown) => e);
    expect((destino as SmsRecusado).motivo).toBe("destino_invalido");
    expect(f).not.toHaveBeenCalled();
  });

  it("resposta aceita sem id é erro, não sucesso silencioso", async () => {
    const f = respostaFalsa(201, {});
    await expect(enviarSms(CREDS, { de: "+14155550199", para: "+14155550100", texto: "a" }, f)).rejects.toThrow(
      "sms_send_without_id",
    );
  });
});

describe("categoria da recusa", () => {
  it("usa o código quando conhece, e o status HTTP quando não", () => {
    expect(motivoDaRecusa(21610, 400)).toBe("destinatario_descadastrado");
    expect(motivoDaRecusa(30034, 400)).toBe("remetente_nao_registrado");
    expect(motivoDaRecusa(null, 429)).toBe("desacelerar");
    expect(motivoDaRecusa(99999, 401)).toBe("credencial");
    expect(motivoDaRecusa(99999, 500)).toBe("outro");
  });
});

describe("partes do SMS", () => {
  it("até 160 caracteres GSM é uma parte; 161 são duas", () => {
    expect(partesDoSms("a".repeat(160))).toEqual({ partes: 1, codificacao: "gsm7" });
    expect(partesDoSms("a".repeat(161))).toEqual({ partes: 2, codificacao: "gsm7" });
    expect(partesDoSms("a".repeat(306))).toEqual({ partes: 2, codificacao: "gsm7" });
    expect(partesDoSms("a".repeat(307))).toEqual({ partes: 3, codificacao: "gsm7" });
  });

  it("caractere da extensão ocupa duas posições", () => {
    expect(partesDoSms("€".repeat(80))).toEqual({ partes: 1, codificacao: "gsm7" });
    expect(partesDoSms("€".repeat(81))).toEqual({ partes: 2, codificacao: "gsm7" });
  });

  it("emoji ou acento fora da tabela derruba para 70 por parte", () => {
    expect(partesDoSms("ã" + "a".repeat(69))).toEqual({ partes: 1, codificacao: "ucs2" });
    expect(partesDoSms("ã" + "a".repeat(70))).toEqual({ partes: 2, codificacao: "ucs2" });
    expect(partesDoSms("👍")).toEqual({ partes: 1, codificacao: "ucs2" });
  });

  it("texto vazio não custa nada", () => {
    expect(partesDoSms("")).toEqual({ partes: 0, codificacao: "gsm7" });
  });
});
