import { describe, expect, it } from "vitest";

import {
  readTelegramUpdate,
  telegramExternalId,
  telegramIdentity,
  verifyTelegramSecretToken,
} from "@/lib/channels/bot/webhook";

/**
 * O CONTRATO DO UPDATE DO TELEGRAM — módulo puro, sem banco e sem rede.
 *
 * ## Por que este arquivo existe
 *
 * O Telegram é o único canal do seam que NÃO assina o corpo. A prova de origem é
 * o `secret_token` inventado no `setWebhook`, devolvido em TODO update no
 * cabeçalho `X-Telegram-Bot-Api-Secret-Token`. Se essa conferência aceitar o
 * que não devia, quem descobrir a URL do webhook escreve na caixa de entrada de
 * um cliente — e o sintoma (uma mensagem estranha na conversa) não aponta para
 * a autenticação.
 *
 * A outra metade é o PARSE: o que a v1 atende (texto em conversa privada) e o
 * que ela recusa em voz alta (grupo, mídia, edição). Recusar AQUI é o que faz a
 * rota devolver 200 com motivo em vez de 500 — e 500, neste canal, significa
 * REENTREGA indefinida.
 */

const SEGREDO = "0123456789abcdef0123456789abcdef";
const BOT = "777";

function update(over: Record<string, unknown> = {}, msgOver: Record<string, unknown> = {}) {
  return {
    update_id: 100,
    message: {
      message_id: 15,
      date: 1_767_000_000,
      chat: { id: 5551, type: "private", first_name: "Ana" },
      from: { id: 42, is_bot: false, first_name: "Ana", last_name: "Souza", username: "anasouza" },
      text: "oi, tudo bem?",
      ...msgOver,
    },
    ...over,
  };
}

describe("secret_token do Telegram — a única prova de origem", () => {
  it("aceita o segredo que nós mesmos gravamos", () => {
    expect(verifyTelegramSecretToken(SEGREDO, SEGREDO)).toBe(true);
  });

  it("recusa segredo diferente, inclusive por UM caractere", () => {
    expect(verifyTelegramSecretToken(`${SEGREDO.slice(0, -1)}b`, SEGREDO)).toBe(false);
  });

  it("recusa cabeçalho ausente ou vazio — o caminho do POST sem prova", () => {
    expect(verifyTelegramSecretToken(null, SEGREDO)).toBe(false);
    expect(verifyTelegramSecretToken("", SEGREDO)).toBe(false);
  });

  it("falha fechado quando a sessão não tem segredo (decifra devolveu null)", () => {
    expect(verifyTelegramSecretToken(SEGREDO, null)).toBe(false);
  });

  it("recusa segredo curto demais — lixo de decifra não vira senha", () => {
    expect(verifyTelegramSecretToken("curto", "curto")).toBe(false);
  });

  it("recusa tamanho diferente sem estourar no timingSafeEqual", () => {
    // `timingSafeEqual` LANÇA com buffers de tamanhos diferentes; sem a guarda
    // de tamanho, um cabeçalho curto derrubaria a rota com 500 — que o Telegram
    // reentrega.
    expect(() => verifyTelegramSecretToken("a".repeat(SEGREDO.length + 1), SEGREDO)).not.toThrow();
    expect(verifyTelegramSecretToken("a".repeat(SEGREDO.length + 1), SEGREDO)).toBe(false);
  });
});

describe("id canônico e identidade", () => {
  it("o external_id carrega o ROBÔ: message_id só é único dentro da conversa de um bot", () => {
    // Dois bots recebendo a mensagem 15 do mesmo chat_id NÃO podem colidir no
    // `unique (organization_id, external_id)` — a segunda seria descartada como
    // duplicata e a mensagem de um cliente sumiria.
    expect(telegramExternalId("111", "5551", 15)).toBe("tg:111:5551:15");
    expect(telegramExternalId("222", "5551", 15)).not.toBe(telegramExternalId("111", "5551", 15));
  });

  it("a identidade social é opaca e escopada pelo robô", () => {
    expect(telegramIdentity("111", "42")).toBe("telegram:111:42");
  });
});

describe("readTelegramUpdate — o que entra na v1", () => {
  it("mensagem de texto em conversa privada", () => {
    const r = readTelegramUpdate(update(), BOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.update).toMatchObject({
      externalId: "tg:777:5551:15",
      chatId: "5551",
      userId: "42",
      text: "oi, tudo bem?",
      displayName: "Ana Souza",
      sentAt: new Date(1_767_000_000 * 1000).toISOString(),
    });
  });

  it("o `chat_id` é o ENDEREÇO da resposta (a conversa é endereçada por ele)", () => {
    const r = readTelegramUpdate(update({}, { chat: { id: -1001234, type: "private" } }), BOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Negativo é id de grupo supergrupo no vocabulário do Telegram; aqui o tipo
    // diz `private`, e o que importa é que o id chega intacto como string.
    expect(r.update.chatId).toBe("-1001234");
  });

  it("sem nome civil, cai no @username", () => {
    const r = readTelegramUpdate(
      update({}, { from: { id: 42, is_bot: false, username: "anasouza" } }),
      BOT,
    );
    expect(r.ok && r.update.displayName).toBe("anasouza");
  });

  it("sem `date`, a hora é a da chegada — não uma data inventada em 1970", () => {
    const r = readTelegramUpdate(update({}, { date: undefined }), BOT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new Date(r.update.sentAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("readTelegramUpdate — o que a v1 RECUSA (e por que responder 200)", () => {
  it("grupo/supergrupo: fora da v1 (`groups: none` na capability)", () => {
    const r = readTelegramUpdate(update({}, { chat: { id: -999, type: "group" } }), BOT);
    expect(r).toEqual({ ok: false, motivo: "sem_interesse", detalhe: "chat.type=group" });
  });

  it("mensagem de OUTRO robô não é atendimento", () => {
    const r = readTelegramUpdate(update({}, { from: { id: 1, is_bot: true } }), BOT);
    expect(r).toEqual({ ok: false, motivo: "sem_interesse", detalhe: "from.is_bot" });
  });

  it("mídia sem texto: a T2 persiste o anexo; a v1 não finge que a legenda é tudo", () => {
    const r = readTelegramUpdate(update({}, { text: undefined, photo: [{ file_id: "x" }] }), BOT);
    expect(r).toEqual({ ok: false, motivo: "sem_interesse", detalhe: "photo" });
  });

  it("edição de mensagem não é mensagem nova", () => {
    const r = readTelegramUpdate({ update_id: 1, edited_message: { message_id: 1 } }, BOT);
    expect(r).toMatchObject({ ok: false, motivo: "sem_interesse" });
  });

  it("corpo que não é objeto: 400, não 200", () => {
    for (const corpo of [null, "texto", 42, []]) {
      expect(readTelegramUpdate(corpo, BOT)).toMatchObject({ ok: false, motivo: "json_invalido" });
    }
  });

  it("mensagem sem `chat.id` é inválida, não um contato órfão", () => {
    const r = readTelegramUpdate(update({}, { chat: { type: "private" } }), BOT);
    expect(r).toMatchObject({ ok: false, motivo: "json_invalido", detalhe: "message.chat.id" });
  });
});
