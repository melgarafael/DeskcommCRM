import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: vi.fn(async () => undefined),
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: vi.fn(async () => undefined),
}));

import { ingestOlxInbound } from "@/lib/channels/olx/ingest";
import type { MensagemDeEntradaOlx } from "@/lib/channels/adapters/olx";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";

/**
 * A entrada do canal OLX: webhook → contato, conversa, mensagem (issue #2927).
 *
 * O que se prova aqui é o EFEITO — o que foi escrito, e o que NÃO foi. O
 * contrato do payload é prova da leitura pura (`channel-adapter-olx.test.ts`);
 * a pergunta desta fatia é se a mensagem vira linha no Inbox do contato e da
 * organização certos, e se o eco não duplica.
 */

function mensagem(over: Partial<MensagemDeEntradaOlx> = {}): MensagemDeEntradaOlx {
  return {
    chatId: "chat-abc",
    messageId: "msg-1",
    message: "Olá, tenho interesse",
    origin: "buyer",
    senderType: "buyer",
    name: "Fulana",
    email: "cliente@exemplo.com",
    phone: "+55 31 99999-8888",
    messageTimestamp: "2026-10-22T12:00:00.000",
    listId: "listing-9",
    ...over,
  };
}

interface Rastreio {
  rpcs: { nome: string; args: Record<string, unknown> }[];
  inseridas: Record<string, unknown>[];
  updates: { tabela: string; corpo: Record<string, unknown> }[];
}

/** Um admin falso que registra tudo que foi escrito e devolve o que o teste manda. */
function adminFalso(opcoes: {
  conversaExistente?: { id: string; contact_id: string } | null;
  erroDeInsert?: { code: string; message: string } | null;
} = {}): { admin: unknown; rastreio: Rastreio } {
  const rastreio: Rastreio = { rpcs: [], inseridas: [], updates: [] };

  const cadeiaConsulta = (data: unknown, error: unknown = null) => {
    const q: Record<string, unknown> = {};
    q.eq = () => q;
    q.is = () => q;
    q.maybeSingle = async () => ({ data, error });
    return q;
  };
  const cadeiaUpdate = (tabela: string) => {
    const q: Record<string, unknown> = {};
    q.eq = () => q;
    q.is = () => q;
    q.then = (resolver: (r: unknown) => unknown) => {
      rastreio.updates.push({ tabela, corpo: {} });
      return resolver({ data: null, error: null });
    };
    return q;
  };

  const admin = {
    from(tabela: string) {
      return {
        select: () => {
          if (tabela === "conversations") {
            return cadeiaConsulta(opcoes.conversaExistente ?? null);
          }
          return cadeiaConsulta(null);
        },
        update: (corpo: Record<string, unknown>) => {
          rastreio.updates.push({ tabela, corpo });
          return cadeiaUpdate(tabela);
        },
        insert: (corpo: Record<string, unknown>) => {
          rastreio.inseridas.push(corpo);
          return {
            select: () => ({
              maybeSingle: async () => ({
                data: opcoes.erroDeInsert ? null : { id: "msg-interna-1" },
                error: opcoes.erroDeInsert ?? null,
              }),
            }),
          };
        },
      };
    },
    async rpc(nome: string, args: Record<string, unknown>) {
      rastreio.rpcs.push({ nome, args });
      if (nome === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (nome === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      return { data: null, error: null };
    },
  };

  return { admin, rastreio };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a mensagem do comprador vira linha no Inbox", () => {
  it("contato, conversa e mensagem no escopo da SESSÃO que recebeu o webhook", async () => {
    const { admin, rastreio } = adminFalso();
    const r = await ingestOlxInbound(admin as never, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      mensagem: mensagem(),
    });

    expect(r).toMatchObject({ status: "ingested", conversationId: "conversa-1", messageId: "msg-interna-1" });

    // O contato nasce pelo telefone que a OLX mandou, na organização da sessão.
    expect(rastreio.rpcs).toContainEqual(
      expect.objectContaining({
        nome: "fn_upsert_wa_contact",
        // A mesma normalização do produto: o contato nasce pelo telefone do payload.
        args: expect.objectContaining({
          p_org: "org-1",
          p_kind: "phone",
          p_phone: canonicalPhoneBR("+55 31 99999-8888"),
        }),
      }),
    );
    // A conversa é da SESSÃO, e a thread do provider vai para a coluna que o
    // envio vai endereçar.
    expect(rastreio.rpcs).toContainEqual(
      expect.objectContaining({
        nome: "fn_upsert_wa_conversation",
        args: expect.objectContaining({ p_org: "org-1", p_contact: "contato-1", p_session: "sess-1" }),
      }),
    );
    expect(rastreio.updates).toContainEqual({
      tabela: "conversations",
      corpo: { provider_conversation_id: "chat-abc" },
    });

    // A mensagem: mesma organização, mesma sessão, `external_id` = messageId da
    // OLX (é a chave do dedup) e o anúncio no metadata.
    expect(rastreio.inseridas).toHaveLength(1);
    expect(rastreio.inseridas[0]).toMatchObject({
      organization_id: "org-1",
      conversation_id: "conversa-1",
      contact_id: "contato-1",
      channel_session_id: "sess-1",
      external_id: "msg-1",
      direction: "inbound",
      sent_via: "external_device",
      type: "text",
      body: "Olá, tenho interesse",
      sent_at: "2026-10-22T12:00:00.000",
      metadata: { olx_list_id: "listing-9", olx_sender_type: "buyer" },
    });

    // E os efeitos de produto (opt-out, demanda, despacho) rodam para a
    // mensagem que acabou de entrar.
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: "org-1",
        contactId: "contato-1",
        conversationId: "conversa-1",
        channelSessionId: "sess-1",
        origem: "olx_webhook",
      }),
    );
  });

  it("sem telefone, a thread vira a âncora opaca do contato", async () => {
    const { admin, rastreio } = adminFalso();
    const r = await ingestOlxInbound(admin as never, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      mensagem: mensagem({ phone: null }),
    });
    expect(r.status).toBe("ingested");
    expect(rastreio.rpcs).toContainEqual(
      expect.objectContaining({
        nome: "fn_upsert_wa_contact",
        args: expect.objectContaining({ p_kind: "lid", p_lid: "chat-abc", p_phone: null }),
      }),
    );
  });

  it("reentrega (23505) é dedup, não erro — e não duplica a linha", async () => {
    const { admin, rastreio } = adminFalso({
      conversaExistente: { id: "conversa-1", contact_id: "contato-1" },
      erroDeInsert: { code: "23505", message: "duplicate key" },
    });
    const r = await ingestOlxInbound(admin as never, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      mensagem: mensagem(),
    });
    expect(r).toMatchObject({ status: "duplicate", conversationId: "conversa-1" });
    expect(rastreio.rpcs).toHaveLength(0); // conversa já existe: não recria contato
  });
});

describe("o eco da própria conta não duplica mensagem", () => {
  it("é cortado ANTES de qualquer escrita — uma entrada, zero linha nova", async () => {
    // Qualquer toque no banco derruba o teste: o eco não pode nem perguntar.
    const nada = new Proxy(
      {},
      {
        get() {
          throw new Error("o eco da própria conta não pode tocar o banco");
        },
      },
    );

    const r = await ingestOlxInbound(nada as never, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      mensagem: mensagem({ origin: "seller", messageId: "msg-eco" }),
    });

    expect(r).toEqual({ status: "ignored", reason: "eco_da_conta" });
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });
});
