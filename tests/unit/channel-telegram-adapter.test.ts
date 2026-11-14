import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutboundEnvelope } from "@/lib/channels/types";

/**
 * ADAPTER DO BOT DO TELEGRAM — envio e tradução de formato.
 *
 * ## O que este arquivo vigia
 *
 *   1. o endereço do envio é o `chat_id` da CONVERSA, não o contato (o Telegram
 *      não expõe telefone; derivar do contato não teria de onde);
 *   2. o `externalId` devolvido é o id canônico do canal (`tg:<robô>:<chat>:<msg>`),
 *      que é o que permite casar a resposta do cliente com a mensagem citada;
 *   3. o adapter NÃO inventa sucesso: sem id da plataforma, LANÇA em vez de
 *      devolver `null` (que o chamador gravaria como `sent`);
 *   4. mídia é recusada nomeando a fatia (T2) — não sai o texto da legenda sem
 *      o anexo.
 */

const enviados: { url: string; body: Record<string, unknown> }[] = [];
let resposta: { ok: boolean; corpo: unknown; status?: number } = {
  ok: true,
  corpo: { ok: true, result: { message_id: 99 } },
};

const credsFake = vi.hoisted(() => ({ valor: null as null | { token: string; botId: string } }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/bot/credentials", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/channels/bot/credentials")>();
  return {
    ...real,
    telegramCredsForBotId: async () => credsFake.valor,
  };
});

const { telegramAdapter, telegramChatIdFromExternalId, telegramMessageId } = await import(
  "@/lib/channels/adapters/telegram"
);

const ENVELOPE: OutboundEnvelope = {
  organizationId: "org-1",
  sessionRef: "777",
  to: "provider-chat",
  providerConversationId: "5551",
  kind: "text",
  body: "já resolvi, obrigado!",
};

beforeEach(() => {
  enviados.length = 0;
  credsFake.valor = { token: "123456:segredo-do-bot", botId: "777" };
  resposta = { ok: true, corpo: { ok: true, result: { message_id: 99 } } };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    enviados.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const status = resposta.status ?? (resposta.ok ? 200 : 400);
    return {
      ok: resposta.ok,
      status,
      text: async () => JSON.stringify(resposta.corpo),
      json: async () => resposta.corpo,
    } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("envio", () => {
  it("manda para o chat_id da conversa, com prévia de link desligada", async () => {
    const r = await telegramAdapter.send(ENVELOPE);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.url).toContain("/sendMessage");
    expect(enviados[0]!.body).toMatchObject({
      chat_id: "5551",
      text: "já resolvi, obrigado!",
      disable_web_page_preview: true,
    });
    expect(r.externalId).toBe("tg:777:5551:99");
  });

  it("sem chat_id conhecido, LANÇA — o envio livre espera a primeira mensagem", async () => {
    await expect(
      telegramAdapter.send({ ...ENVELOPE, providerConversationId: null }),
    ).rejects.toThrow(/telegram_no_conversation/);
    expect(enviados).toHaveLength(0);
  });

  it("sem credencial na sessão, LANÇA em vez de fingir envio", async () => {
    credsFake.valor = null;
    await expect(telegramAdapter.send(ENVELOPE)).rejects.toThrow(/telegram_not_configured/);
    expect(enviados).toHaveLength(0);
  });

  it("plataforma aceita o envio sem id: LANÇA (o chamador não pode gravar `sent` sem id)", async () => {
    resposta = { ok: true, corpo: { ok: true, result: {} } };
    await expect(telegramAdapter.send(ENVELOPE)).rejects.toThrow(/telegram_send_without_id/);
  });

  it("erro da Bot API vira exceção com o status — não um sucesso vazio", async () => {
    resposta = { ok: false, status: 403, corpo: { ok: false, description: "bot was blocked by the user" } };
    await expect(telegramAdapter.send(ENVELOPE)).rejects.toThrow(/403/);
  });

  it("mídia é recusada nomeando a fatia — nunca a legenda sozinha", async () => {
    await expect(telegramAdapter.send({ ...ENVELOPE, kind: "image" })).rejects.toThrow(
      /telegram_media_not_supported/,
    );
    expect(enviados).toHaveLength(0);
  });

  it("corpo vazio não vira mensagem em branco no Telegram", async () => {
    await expect(telegramAdapter.send({ ...ENVELOPE, body: "   " })).rejects.toThrow(
      /telegram_empty_body/,
    );
  });

  it("cita a mensagem quando a thread traz o id canônico", async () => {
    await telegramAdapter.send({ ...ENVELOPE, replyToExternalId: "tg:777:5551:15" });
    expect(enviados[0]!.body.reply_to_message_id).toBe(15);
  });

  it("id canônico de OUTRO canal não vira citação torta", async () => {
    await telegramAdapter.send({ ...ENVELOPE, replyToExternalId: "zernio:abc:15" });
    expect(enviados[0]!.body).not.toHaveProperty("reply_to_message_id");
  });

  it("o `beforeSend` roda ANTES do transporte (é a revalidação da janela)", async () => {
    const ordem: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      ordem.push("transporte");
      enviados.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return { ok: true, status: 200, text: async () => "{}", json: async () => resposta.corpo } as unknown as Response;
    });
    await telegramAdapter.send({
      ...ENVELOPE,
      beforeSend: async () => {
        ordem.push("beforeSend");
      },
    });
    expect(ordem).toEqual(["beforeSend", "transporte"]);
  });
});

describe("destinatário e chat_id a partir do id canônico", () => {
  // O bot endereça por `chat_id`, nunca por telefone: a entrada vem vazia de
  // propósito, e é isso que a asserção prova.
  const SEM_TELEFONE = {
    isGroup: false,
    groupChatId: null,
    phoneNumber: null,
    waIdentity: null,
  };

  it("resolveRecipient devolve o marcador de thread, nunca um telefone", () => {
    expect(telegramAdapter.resolveRecipient(SEM_TELEFONE)).toBe("provider-chat");
  });

  it("grupo não tem destinatário — a v1 não atende grupo", () => {
    expect(telegramAdapter.resolveRecipient({ ...SEM_TELEFONE, isGroup: true })).toBeNull();
  });

  it("`isConfigured` é true: a credencial mora na sessão e este método é síncrono", () => {
    // Responder `false` faria o handler gravar `queued` sem tentar enviar, com o
    // canal conectado — o defeito medido no canal intermediado.
    expect(telegramAdapter.isConfigured()).toBe(true);
  });

  it("extrai chat e mensagem do id canônico", () => {
    expect(telegramChatIdFromExternalId("tg:777:-1001234:15")).toBe("-1001234");
    expect(telegramMessageId("tg:777:-1001234:15")).toBe("15");
    expect(telegramMessageId("tg:777:5551:abc")).toBeNull();
    expect(telegramMessageId("whatsapp:5551")).toBeNull();
  });
});
