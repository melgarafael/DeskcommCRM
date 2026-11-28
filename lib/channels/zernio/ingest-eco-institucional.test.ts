import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SocialMessage } from "@/lib/channels/social/parser";

const mockMarcarConversa = vi.fn(async () => {});
const mockPausarIa = vi.fn(async () => true);

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: (...args: unknown[]) => mockMarcarConversa(...(args as [])),
}));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({
  pausarIaPorAtendimentoManual: (...args: unknown[]) => mockPausarIa(...(args as [])),
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: vi.fn(async () => {}),
}));
vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/zernio/credentials")>()),
  resolveZernioCreds: vi.fn(),
}));
vi.mock("@/lib/campanhas/transmissao", async (orig) => ({
  ...(await orig<typeof import("@/lib/campanhas/transmissao")>()),
  ecoDaTransmissao: vi.fn(async () => null),
  ligarEcoAoDestinatario: vi.fn(async () => undefined),
}));

import { ingestZernioInbound } from "@/lib/channels/zernio/ingest";

interface MensagemEmBanco {
  id: string;
  body: string | null;
  type: string;
  external_id: string | null;
  status: string;
  sent_via: string;
  metadata: Record<string, unknown>;
  updated_at: string;
}

const ENTRADA = { organizationId: "org-1", channelSessionId: "sess-1" };

function payloadZernio(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-inst-1",
    event: "message.sent",
    account: { id: "acc-1" },
    conversation: { participantId: "5511999887766" },
    message: {
      id: "m-ext-1",
      conversationId: "thread-zernio-1",
      platform: "whatsapp",
      platformMessageId: "wamid.inst.001",
      direction: "outgoing",
      sentVia: "api",
      text: "Aviso institucional de faturamento",
      attachments: [],
      sender: { id: "acc-1", name: "Empresa" },
      sentAt: "2026-11-25T15:00:00.000Z",
      ...overrides,
    },
  };
}

function criarDb(opts: {
  conversaExistente: { id: string; contact_id: string } | null;
  mensagensNoBanco: MensagemEmBanco[];
}) {
  const insertsMessages: Array<Record<string, unknown>> = [];
  const updatesContacts: Array<Record<string, unknown>> = [];

  function selectMessagesChain(filtros: Record<string, unknown> = {}): Record<string, unknown> {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "eq") {
            return (col: string, val: unknown) => selectMessagesChain({ ...filtros, [col]: val });
          }
          if (prop === "in") {
            return (col: string, vals: unknown[]) =>
              selectMessagesChain({ ...filtros, [`${col}:in`]: vals });
          }
          if (prop === "gte" || prop === "limit" || prop === "select") {
            return () => proxy;
          }
          if (prop === "maybeSingle" || prop === "single") {
            return async () => ({ data: opts.mensagensNoBanco[0] ?? null, error: null });
          }
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) => {
              const filtradas = opts.mensagensNoBanco.filter((m) => {
                if (filtros.sent_via && m.sent_via !== filtros.sent_via) return false;
                if (
                  Array.isArray(filtros["status:in"]) &&
                  !(filtros["status:in"] as unknown[]).includes(m.status)
                ) {
                  return false;
                }
                return true;
              });
              return resolve({ data: filtradas, error: null });
            };
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  }

  function chainGenerico(tabela: string, op: string): Record<string, unknown> {
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "maybeSingle" || prop === "single") {
            if (tabela === "conversations" && op === "select") {
              return async () => ({ data: opts.conversaExistente, error: null });
            }
            if (tabela === "contacts" && op === "select") {
              return async () => ({ data: { id: "contact-1" }, error: null });
            }
            return async () => ({ data: { id: "msg-new-1" }, error: null });
          }
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
          }
          return () => proxy;
        },
      },
    );
    return proxy;
  }

  const admin = {
    rpc: async (nome: string) => ({
      data:
        nome === "fn_upsert_wa_contact"
          ? "contact-1"
          : nome === "fn_upsert_wa_conversation"
            ? "conv-1"
            : null,
      error: null,
    }),
    from: (tabela: string) => ({
      select: () =>
        tabela === "messages" ? selectMessagesChain() : chainGenerico(tabela, "select"),
      insert: (payload: Record<string, unknown>) => {
        if (tabela === "messages") insertsMessages.push(payload);
        return chainGenerico(tabela, "insert");
      },
      update: (payload: Record<string, unknown>) => {
        if (tabela === "contacts") updatesContacts.push(payload);
        return chainGenerico(tabela, "update");
      },
    }),
  } as never;

  return { admin, insertsMessages, updatesContacts };
}

beforeEach(() => {
  mockMarcarConversa.mockClear();
  mockPausarIa.mockClear();
});

describe("Zernio: eco institucional em corrida pré-carimbo não contamina o atendimento", () => {
  it("conversa existente: eco sentVia='api' de envio institucional em voo não insere duplicata, não chama marcarConversa e não pausa IA", async () => {
    const db = criarDb({
      conversaExistente: { id: "conv-1", contact_id: "contact-1" },
      mensagensNoBanco: [
        {
          id: "msg-inst-1",
          body: "Aviso institucional de faturamento",
          type: "text",
          external_id: null,
          status: "queued",
          sent_via: "system",
          metadata: { dispatch_mode: "institutional" },
          updated_at: new Date().toISOString(),
        },
      ],
    });

    const resultado = await ingestZernioInbound(db.admin, {
      ...ENTRADA,
      payload: payloadZernio(),
    });

    expect(resultado).toEqual({ status: "duplicate", conversationId: "conv-1" });
    expect(db.insertsMessages).toHaveLength(0);
    expect(db.updatesContacts).toHaveLength(0);
    expect(mockMarcarConversa).not.toHaveBeenCalled();
    expect(mockPausarIa).not.toHaveBeenCalled();
  });

  it("ramo sem thread prévia: após resolver conversa, eco institucional também evita duplicata e carimbo operacional", async () => {
    const db = criarDb({
      conversaExistente: null,
      mensagensNoBanco: [
        {
          id: "msg-inst-2",
          body: "Aviso institucional de faturamento",
          type: "text",
          external_id: "wamid.inst.001",
          status: "sent",
          sent_via: "system",
          metadata: { dispatch_mode: "institutional" },
          updated_at: new Date().toISOString(),
        },
      ],
    });

    const resultado = await ingestZernioInbound(db.admin, {
      ...ENTRADA,
      payload: payloadZernio(),
    });

    expect(resultado).toEqual({ status: "duplicate", conversationId: "conv-1" });
    expect(db.insertsMessages).toHaveLength(0);
    expect(mockMarcarConversa).not.toHaveBeenCalled();
    expect(mockPausarIa).not.toHaveBeenCalled();
  });

  it("rede social pelo Zernio (sentVia ausente): eco pré-carimbo de envio institucional também é isolado", async () => {
    const db = criarDb({
      conversaExistente: { id: "conv-social-1", contact_id: "contact-1" },
      mensagensNoBanco: [
        {
          id: "msg-social-inst-1",
          body: "Aviso institucional via Instagram",
          type: "text",
          external_id: null,
          status: "sending",
          sent_via: "system",
          metadata: { dispatch_mode: "institutional" },
          updated_at: new Date().toISOString(),
        },
      ],
    });

    const socialMessage: SocialMessage = {
      platform: "instagram",
      participantId: "ig-user-1",
      accountId: "acc-ig-1",
      conversationId: "thread-ig-1",
      externalId: "social:acc-ig-1:m-1",
      direction: "outbound",
      kind: "message",
      status: "sent",
      text: "Aviso institucional via Instagram",
      sentAt: "2026-11-25T15:00:00.000Z",
      attachments: [],
      referral: null,
      identity: {
        phone: null,
        bsuid: null,
        username: "cliente.ig",
        displayName: "Cliente IG",
        anchor: null,
      },
    };

    const resultado = await ingestZernioInbound(db.admin, {
      ...ENTRADA,
      payload: {},
      socialMessage,
    });

    expect(resultado).toEqual({ status: "duplicate", conversationId: "conv-social-1" });
    expect(db.insertsMessages).toHaveLength(0);
    expect(mockMarcarConversa).not.toHaveBeenCalled();
    expect(mockPausarIa).not.toHaveBeenCalled();
  });

  it("controle: envio pelo celular com texto parecido mas sem sentVia='api' continua sendo ingerido normalmente", async () => {
    const db = criarDb({
      conversaExistente: { id: "conv-1", contact_id: "contact-1" },
      mensagensNoBanco: [
        {
          id: "msg-inst-1",
          body: "Aviso institucional de faturamento",
          type: "text",
          external_id: null,
          status: "queued",
          sent_via: "system",
          metadata: { dispatch_mode: "institutional" },
          updated_at: new Date().toISOString(),
        },
      ],
    });

    const resultado = await ingestZernioInbound(db.admin, {
      ...ENTRADA,
      payload: payloadZernio({ sentVia: undefined }),
    });

    expect(resultado.status).toBe("ingested");
    expect(db.insertsMessages).toHaveLength(1);
    expect(mockMarcarConversa).toHaveBeenCalledTimes(1);
    expect(mockPausarIa).toHaveBeenCalledTimes(1);
  });
});
