import { describe, expect, it } from "vitest";

import { acceptsInboundWebhook, verifyInboundWebhookSignature } from "@/lib/channels/inbound";
import {
  capabilitiesOf,
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_DE_TELEFONE,
  transportaMensagem,
} from "@/lib/channels/capabilities";
import { CANAIS_DE_CONVERSA } from "@/lib/channels/canais-de-conversa";
import { origemDoNegocioPeloCanal } from "@/lib/channels/origem-do-negocio";
import { getAdapter } from "@/lib/channels";
import { TELEGRAM_SECRET_HEADER } from "@/lib/channels/bot/webhook";

/**
 * O BOT DO TELEGRAM NO SEAM — capability, lista de canais, origem e a porta de
 * entrada.
 *
 * ## Por que este arquivo existe
 *
 * Os módulos do canal podem estar certos e o canal mesmo assim não existir: quem
 * decide se um provider ENTRA é a matriz de capabilities, a lista
 * `PROVIDERS_DE_MENSAGEM` e o ramo do webhook. Foi assim que o Datafy nasceu
 * invisível (fora de `PROVIDERS_DE_MENSAGEM`, sem botão e sem ingestão).
 *
 * E há a armadilha oposta, medida no #3358/#3364: um canal SEM telefone que
 * entra em `PROVIDERS_DE_TELEFONE` faz o lembrete por telefone escolhê-lo para
 * discar para um número que ele não alcança. O Telegram não tem telefone; ficar
 * de fora dessa lista é o contrato, não um detalhe.
 */

const SEGREDO = "b".repeat(64);
const RAW = JSON.stringify({ update_id: 1 });

function headers(over: Record<string, string> = {}): Headers {
  return new Headers(over);
}

describe("capability do Telegram", () => {
  it("a matriz conhece o provider — sem isto o canal não aparece em lugar nenhum", () => {
    expect(() => capabilitiesOf("telegram")).not.toThrow();
    const cap = capabilitiesOf("telegram");
    expect(cap.groups).toBe("none");
    // Bot API não tem janela de 24h: responder fora da janela não é bloqueado
    // pelo provider (o que não dispensa a política do produto).
    expect(cap.freeformOutsideWindow).toBe(true);
    // Sem cobrança por mensagem: a Bot API é gratuita para mensagens de serviço.
    expect(cap.costPerMessage).toBe(false);
    // ~1 mensagem/segundo por conversa é o que o próprio Telegram pede.
    expect(cap.minIntervalMs).toBe(1000);
    // Não há aparelho pareado: QR, bateria e pareamento não se aplicam.
    expect(cap.phonebook).toBe(false);
  });

  it("está em PROVIDERS_DE_MENSAGEM e FORA de PROVIDERS_DE_TELEFONE", () => {
    expect(PROVIDERS_DE_MENSAGEM).toContain("telegram");
    expect(PROVIDERS_DE_TELEFONE).not.toContain("telegram");
    expect(transportaMensagem("telegram")).toBe(true);
  });

  it("o adapter está registrado — provider na matriz e sem adapter é canal morto", () => {
    const adapter = getAdapter("telegram");
    expect(adapter.provider).toBe("telegram");
  });

  it("o canal da conversa existe na lista derivada do catálogo", () => {
    expect(CANAIS_DE_CONVERSA).toContain("telegram");
  });

  it("a origem do negócio é própria — senão todo lead do bot conta como WhatsApp", () => {
    const origem = origemDoNegocioPeloCanal("telegram");
    expect(origem.source).toBe("telegram");
    expect(origem.rotulo).toBe("Telegram");
  });
});

describe("porta de entrada do webhook", () => {
  it("aceita o provider", () => {
    expect(acceptsInboundWebhook("telegram")).toBe(true);
  });

  it("autentica pelo `secret_token` do cabeçalho, não por HMAC do corpo", () => {
    expect(
      verifyInboundWebhookSignature(
        "telegram",
        RAW,
        headers({ [TELEGRAM_SECRET_HEADER]: SEGREDO }),
        SEGREDO,
      ),
    ).toBe(true);
  });

  it("corpo idêntico com o segredo errado NÃO passa", () => {
    expect(
      verifyInboundWebhookSignature(
        "telegram",
        RAW,
        headers({ [TELEGRAM_SECRET_HEADER]: "c".repeat(64) }),
        SEGREDO,
      ),
    ).toBe(false);
  });

  it("sem o cabeçalho, não passa — a URL sozinha não é credencial", () => {
    expect(verifyInboundWebhookSignature("telegram", RAW, headers(), SEGREDO)).toBe(false);
  });

  it("sessão sem segredo gravado (decifra devolveu null): fail-closed", () => {
    expect(
      verifyInboundWebhookSignature("telegram", RAW, headers({ [TELEGRAM_SECRET_HEADER]: SEGREDO }), null),
    ).toBe(false);
  });

  it("assinatura de OUTRO canal não autoriza o Telegram", () => {
    // Sem o ramo próprio, o fallback do Zernio decidiria — e um HMAC válido de
    // outra integração entraria na caixa de entrada do bot.
    expect(
      verifyInboundWebhookSignature("telegram", RAW, headers({ "x-zernio-signature": "deadbeef" }), SEGREDO),
    ).toBe(false);
  });

  it("provider fora da lista continua recusado (fail-closed)", () => {
    expect(acceptsInboundWebhook("canal_inexistente")).toBe(false);
  });
});
