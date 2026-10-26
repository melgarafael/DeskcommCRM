import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * INGESTÃO DO BOT DO TELEGRAM: update → contato, conversa, mensagem.
 *
 * ## O que este arquivo vigia, e por que cada ponto importa
 *
 *   • `provider_conversation_id` = `chat.id`. Esquecer isso deixa a conversa no
 *     inbox e o operador SEM COMO RESPONDER: o Telegram não endereça por
 *     telefone, e o endereço só chega por aqui.
 *   • `conversations.channel = 'telegram'`. Sem isso o negócio nasce como
 *     WhatsApp e todo relatório por canal conta no lugar errado.
 *   • `external_id` idempotente: o Telegram REENTREGA o que não recebe 200. Um
 *     segundo INSERT igual precisa virar `duplicate`, não uma segunda mensagem.
 *   • grupo/mídia/edição: recusados ANTES de tocar no banco — o update que não
 *     interessa não pode criar contato.
 */

const escritas: { tabela: string; op: string; payload?: unknown }[] = [];

/** Estado que o dublê precisa morder: a sessão, o contato e a corrida do INSERT. */
let sessao: { telegram_bot_id: string | null; provider: string } | null = null;
let contatoExistente: { id: string } | null = null;
let erroDoInsert: { code?: string; message: string } | null = null;

vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: vi.fn(async () => undefined),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const { ingestTelegramInbound } = await import("@/lib/channels/bot/ingest");
const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
const { marcarConversaComMensagem } = await import("@/lib/channels/marcar-conversa");

function chain(tabela: string, op: string, payload?: unknown) {
  // A ESCRITA é registrada na construção: o `payload` do insert/update mora no
  // primeiro elo, e os elos seguintes (`.select("id")`, `.eq(…)`) carregam
  // argumentos que não são o que se quer afirmar.
  if (op === "insert" || op === "update") escritas.push({ tabela, op, payload });
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          if (tabela === "channel_sessions") return async () => ({ data: sessao, error: null });
          if (tabela === "contacts") {
            if (op === "select") return async () => ({ data: contatoExistente, error: null });
            // A falha de escrita é injetada na MENSAGEM: é o INSERT dela que o
            // caso "erro que não é duplicata" mede.
            return async () => ({ data: { id: "contact-1" }, error: null });
          }
          if (tabela === "messages")
            return async () =>
              erroDoInsert ? { data: null, error: erroDoInsert } : { data: { id: "msg-1" }, error: null };
          return async () => ({ data: null, error: null });
        }
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => ok({ data: [{ id: "row-1" }], error: null });
        }
        return (...args: unknown[]) => {
          if (["select", "eq", "is", "not"].includes(String(prop))) {
            escritas.push({ tabela, op: String(prop), payload: args[0] });
          }
          return proxy;
        };
      },
    },
  );
  return proxy;
}

const admin = {
  from(tabela: string) {
    return {
      select: (cols: string) => chain(tabela, "select", cols),
      insert: (payload: unknown) => chain(tabela, "insert", payload),
      update: (payload: unknown) => chain(tabela, "update", payload),
    };
  },
  rpc: async (nome: string) => {
    escritas.push({ tabela: "rpc", op: nome });
    if (nome === "fn_upsert_wa_conversation") return { data: "conv-1", error: null };
    return { data: null, error: null };
  },
} as never;

function update(msgOver: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 15,
      date: 1_767_000_000,
      chat: { id: 5551, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Ana" },
      text: "oi",
      ...msgOver,
    },
  };
}

function chamada(tabela: string, op: string) {
  return escritas.find((e) => e.tabela === tabela && e.op === op);
}

beforeEach(() => {
  escritas.length = 0;
  sessao = { telegram_bot_id: "777", provider: "telegram" };
  contatoExistente = null;
  erroDoInsert = null;
  vi.clearAllMocks();
});

describe("ingestão de uma mensagem privada", () => {
  it("grava contato com identidade social opaca e NÃO grava telefone", async () => {
    const r = await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update(),
    });
    expect(r).toMatchObject({ status: "ingested", conversationId: "conv-1" });

    const insert = chamada("contacts", "insert");
    expect(insert?.payload).toMatchObject({
      organization_id: "org-1",
      social_identity: "telegram:777:42",
      source: "telegram",
    });
    expect(insert?.payload).not.toHaveProperty("phone_number");
  });

  it("a conversa ganha o CHAT_ID como endereço e o canal `telegram`", async () => {
    await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update(),
    });

    const upd = chamada("conversations", "update");
    expect(upd?.payload).toEqual({ channel: "telegram", provider_conversation_id: "5551" });
  });

  it("grava a mensagem com o id canônico, a hora do cliente e `external_device`", async () => {
    await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update(),
    });

    const msg = chamada("messages", "insert");
    expect(msg?.payload).toMatchObject({
      external_id: "tg:777:5551:15",
      direction: "inbound",
      sent_via: "external_device",
      type: "text",
      body: "oi",
      sent_at: new Date(1_767_000_000 * 1000).toISOString(),
    });
  });

  it("a marcação da conversa usa a hora em que o cliente ESCREVEU", async () => {
    await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update(),
    });
    expect(marcarConversaComMensagem).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        direction: "inbound",
        canal: "telegram",
        at: new Date(1_767_000_000 * 1000).toISOString(),
      }),
    );
  });

  it("os efeitos pós-entrada recebem o canal — senão o negócio nasce como whatsapp", async () => {
    await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update(),
    });
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ canal: "telegram", origem: "telegram_webhook" }),
    );
  });

  it("contato que já existe (ficha viva) é reaproveitado, não duplicado", async () => {
    contatoExistente = { id: "contact-9" };
    await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update(),
    });
    expect(chamada("contacts", "insert")).toBeUndefined();
  });
});

describe("idempotência — o Telegram reentrega o que não recebe 200", () => {
  it("23505 vira `duplicate` e a mensagem NÃO é marcada de novo", async () => {
    erroDoInsert = { code: "23505", message: "duplicate key" };
    const r = await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update(),
    });
    expect(r).toEqual({ status: "duplicate", conversationId: "conv-1" });
    expect(marcarConversaComMensagem).not.toHaveBeenCalled();
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });

  it("erro que NÃO é duplicata sobe — 500 é falha de escrita, e o provider reenvia", async () => {
    erroDoInsert = { code: "23503", message: "fk violation" };
    await expect(
      ingestTelegramInbound(admin, {
        organizationId: "org-1",
        channelSessionId: "sess-1",
        payload: update(),
      }),
    ).rejects.toThrow(/telegram_ingest_insert_failed/);
  });
});

describe("recusas — update que não interessa não toca no banco", () => {
  it("grupo: ignorado, sem contato e sem conversa", async () => {
    const r = await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update({ chat: { id: -999, type: "group" } }),
    });
    expect(r).toMatchObject({ status: "ignored" });
    expect(chamada("contacts", "insert")).toBeUndefined();
    expect(chamada("conversations", "update")).toBeUndefined();
  });

  it("mídia: ignorada (T2), sem gravar legenda como mensagem", async () => {
    const r = await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update({ text: undefined, document: { file_id: "x" } }),
    });
    expect(r).toMatchObject({ status: "ignored", reason: "document" });
    expect(chamada("messages", "insert")).toBeUndefined();
  });

  it("sessão de OUTRO provider: ignorada — o webhook não escolhe o canal", async () => {
    sessao = { telegram_bot_id: null, provider: "waha" };
    const r = await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update(),
    });
    expect(r).toEqual({ status: "ignored", reason: "canal_desconhecido" });
    expect(chamada("contacts", "insert")).toBeUndefined();
  });

  it("sessão inexistente (token de caminho órfão): ignorada, sem escrever", async () => {
    sessao = null;
    const r = await ingestTelegramInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      payload: update(),
    });
    expect(r).toEqual({ status: "ignored", reason: "canal_desconhecido" });
    // Nenhuma escrita: só a leitura da sessão. RPC também não é chamado.
    expect(escritas.filter((e) => e.tabela === "rpc")).toHaveLength(0);
    expect(escritas.some((e) => e.tabela === "contacts" || e.tabela === "messages")).toBe(false);
  });
});
