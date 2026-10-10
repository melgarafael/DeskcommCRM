import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseMetaWebhook, type InboundMessageEvent } from "@/lib/channels/meta/webhook";

/**
 * Payloads REAIS capturados da WABA de teste em 2026-07-29 — um texto e uma nota de
 * voz, enviados de um celular de verdade. Mock escrito por quem escreve o parser
 * concorda com ele por construção; foi assim que a Fase 3a descobriu que
 * `parameter_format` só vem se pedido e que `quality_score` vem como objeto.
 */
const REAIS = JSON.parse(
  readFileSync("tests/fixtures/meta/inbound-webhooks.json", "utf8"),
) as Parameters<typeof parseMetaWebhook>[0][];

const inbound = (i: number) =>
  parseMetaWebhook(REAIS[i]!).filter(
    (e): e is InboundMessageEvent => e.kind === "inbound_message",
  );

describe("inbound real — texto", () => {
  it("extrai a mensagem, o remetente e o número NOSSO que recebeu", () => {
    const [e] = inbound(0);
    expect(e).toMatchObject({
      kind: "inbound_message",
      from: "553198966398",
      phoneNumberId: "1103328999528818",
      type: "text",
      text: "oi",
      profileName: "Contato Teste",
    });
  });

  it("o `wamid` vira a chave de idempotência", () => {
    const [e] = inbound(0);
    expect(e!.externalId).toMatch(/^wamid\./);
  });

  it("o timestamp vem em SEGUNDOS — tratá-lo como ms daria 1970", () => {
    const [e] = inbound(0);
    expect(e!.sentAt.getUTCFullYear()).toBe(2026);
  });

  it("texto não tem mídia", () => {
    expect(inbound(0)[0]!.media).toBeNull();
  });
});

describe("inbound real — nota de voz", () => {
  it("reconhece áudio e marca `voice`", () => {
    const [e] = inbound(1);
    expect(e!.type).toBe("audio");
    expect(e!.media).toMatchObject({ voice: true, mime: "audio/ogg; codecs=opus" });
  });

  it("a Meta manda URL PRONTA, não só o media_id", () => {
    // Eu tinha antecipado que viria só o id, exigindo outra chamada à Graph API.
    // Vem os dois — e a URL tem `ext=` de expiração, então baixe na hora.
    const [e] = inbound(1);
    expect(e!.media!.id).toBeTruthy();
    expect(e!.media!.url).toContain("lookaside.fbsbx.com");
  });

  it("nota de voz não tem `text`", () => {
    expect(inbound(1)[0]!.text).toBeNull();
  });
});

describe("o que separa inbound de status de entrega", () => {
  it("`messages[]` é do CONTATO; `statuses[]` é das NOSSAS", () => {
    // Os dois chegam no mesmo `field: "messages"`. Tratá-los no mesmo `if` faria um
    // mascarar o outro quando viessem juntos no mesmo payload.
    const misto = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn1" },
                contacts: [{ wa_id: "5531", profile: { name: "Ana" } }],
                messages: [{ id: "wamid.IN", from: "5531", timestamp: "1785342028", type: "text", text: { body: "oi" } }],
              },
            },
            {
              field: "messages",
              value: { statuses: [{ id: "wamid.OUT", status: "delivered", recipient_id: "5531" }] },
            },
          ],
        },
      ],
    });
    expect(misto.map((e) => e.kind)).toEqual(["inbound_message", "message_status"]);
  });
});

describe("payload capenga não vira linha meia-boca", () => {
  it("mensagem sem id é descartada", () => {
    const r = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [{ field: "messages", value: { messages: [{ from: "5531", type: "text" }] } }],
        },
      ],
    });
    expect(r).toEqual([]);
  });

  it("mensagem sem remetente é descartada", () => {
    const r = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [{ field: "messages", value: { messages: [{ id: "wamid.X", type: "text" }] } }],
        },
      ],
    });
    expect(r).toEqual([]);
  });

  it("tipo que não conhecemos ainda atravessa, sem mídia inventada", () => {
    // Sticker/location/contact chegam com formas próprias. Descartar seria perder
    // mensagem do cliente; inventar mídia seria pior.
    const [e] = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn1" },
                messages: [{ id: "wamid.S", from: "5531", timestamp: "1785342028", type: "location" }],
              },
            },
          ],
        },
      ],
    }) as InboundMessageEvent[];
    expect(e).toMatchObject({ type: "location", text: null, media: null });
  });
});

/**
 * Clique em botão: o contato toca num botão do modelo e a Meta manda `type: "button"`
 * (ou `interactive`, na resposta interativa). Nenhum dos dois cabe no CHECK de
 * `messages.type` — gravados crus, o insert falhava e a resposta sumia do CRM
 * ("Algumas" clicado e a conversa seguia "nunca escreveu").
 */
describe("inbound — clique em botão", () => {
  const envelope = (message: Record<string, unknown>) =>
    ({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "PNID1" },
                contacts: [{ wa_id: "5531900000001", profile: { name: "Ana" } }],
                messages: [{ from: "5531900000001", id: "wamid.BTN1", timestamp: "1785342028", ...message }],
              },
            },
          ],
        },
      ],
    }) as unknown as Parameters<typeof parseMetaWebhook>[0];

  const unico = (message: Record<string, unknown>) => {
    const eventos = parseMetaWebhook(envelope(message)).filter(
      (e): e is InboundMessageEvent => e.kind === "inbound_message",
    );
    expect(eventos).toHaveLength(1);
    return eventos[0]!;
  };

  it("botão de modelo entra como texto, com o rótulo tocado", () => {
    const e = unico({ type: "button", button: { payload: "Algumas", text: "Algumas" } });
    expect(e.type).toBe("text");
    expect(e.text).toBe("Algumas");
    expect(e.media).toBeNull();
  });

  it("sem `text`, o `payload` do botão é o rótulo", () => {
    expect(unico({ type: "button", button: { payload: "NAO_SEI" } }).text).toBe("NAO_SEI");
  });

  it("resposta interativa (botão e lista) entra como texto com o título", () => {
    const botao = unico({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b1", title: "Quero ver" } } });
    expect([botao.type, botao.text]).toEqual(["text", "Quero ver"]);
    const lista = unico({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "l1", title: "Agenda" } } });
    expect([lista.type, lista.text]).toEqual(["text", "Agenda"]);
  });
});
