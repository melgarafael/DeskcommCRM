import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4749 — no WhatsApp pelo Zernio, a resposta dada pelo CELULAR numa conversa
 * que JÁ EXISTE pausa a IA.
 *
 * Medido em produção (1.113.0, `manual_reply_silence_minutes = 30`): a equipe
 * respondeu pelo aplicativo às 10h16, e a IA respondeu ao cliente às 10h19. A
 * saída entrava como `outbound` / `external_device`, mas o ramo da conversa
 * existente só pausava com `input.socialMessage` — o WhatsApp ficava de fora,
 * enquanto o ramo da conversa nova e o WAHA pausavam.
 *
 * Os controles importam tanto quanto o caso principal. Sem eles, o primeiro
 * teste passaria também com uma pausa em TODA saída — e toda resposta da
 * própria IA volta pelo webhook como saída:
 *
 *  - a transmissão do provedor segue sem pausar (migration 0712);
 *  - o eco do nosso envio, já carimbado, sai como `"duplicate"` e não pausa;
 *  - o eco que chega ANTES do carimbo (`sentVia = "api"`) também não pausa.
 */

const ops: { tabela: string; op: string; payload?: unknown }[] = [];
let conversaExistente: { id: string; contact_id: string } | null = null;
/** O `unique (organization_id, external_id)` recusa: é o eco já carimbado. */
let insertDuplicado = false;

/** O builder do PostgREST, encadeável — só o bastante para a ingestão andar. */
function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          if (tabela === "conversations" && op === "select") return async () => ({ data: conversaExistente, error: null });
          if (tabela === "contacts" && op === "select") return async () => ({ data: null, error: null });
          if (tabela === "messages" && op === "insert" && insertDuplicado) {
            return async () => ({ data: null, error: { code: "23505", message: "duplicate key" } });
          }
          return async () => ({ data: { id: "msg-1" }, error: null });
        }
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [{ id: "row-1" }], error: null });
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  ops.push({ tabela, op, payload });
  return proxy;
}

const admin = {
  rpc: async (nome: string) => ({
    data: nome === "fn_upsert_wa_contact" ? "contact-1" : nome === "fn_upsert_wa_conversation" ? "conv-1" : null,
    error: null,
  }),
  from: (tabela: string) => ({
    select: () => chain(tabela, "select"),
    insert: (payload: unknown) => chain(tabela, "insert", payload),
    update: (payload: unknown) => chain(tabela, "update", payload),
  }),
} as never;

vi.mock("@/lib/channels/zernio/credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/channels/zernio/credentials")>()),
  resolveZernioCreds: vi.fn(),
}));
vi.mock("@/lib/escalacao/atendimento-manual", async (orig) => ({
  ...(await orig<typeof import("@/lib/escalacao/atendimento-manual")>()),
  pausarIaPorAtendimentoManual: vi.fn(async () => true),
}));
vi.mock("@/lib/campanhas/transmissao", async (orig) => ({
  ...(await orig<typeof import("@/lib/campanhas/transmissao")>()),
  ecoDaTransmissao: vi.fn(async () => null),
  ligarEcoAoDestinatario: vi.fn(async () => undefined),
}));

import { ingestZernioInbound } from "@/lib/channels/zernio/ingest";
import { pausarIaPorAtendimentoManual } from "@/lib/escalacao/atendimento-manual";

const ENTRADA = { organizationId: "org-1", channelSessionId: "sess-1" };

/**
 * `message.sent` do WhatsApp. Sem `sentVia`: é o digitado no aplicativo do
 * celular, que o provedor não sabe de onde veio (ver `webhook.ts`).
 */
const saidaPeloCelular = (message: Record<string, unknown> = {}) => ({
  id: "evt_1",
  event: "message.sent",
  account: { id: "acc_1" },
  conversation: { participantId: "5511912345678" },
  message: {
    id: "m_1",
    conversationId: "6ad297966c6c507b49d606a1",
    platform: "whatsapp",
    platformMessageId: "wamid.HBgMNTUxMTkxMjM0NTY3OA",
    direction: "outgoing",
    text: "Oi! Já vejo o seu horário",
    attachments: [],
    sender: { id: "acc_1", name: "Clínica Exemplo" },
    sentAt: "2026-11-16T13:16:00.000Z",
    ...message,
  },
});

const pausa = () => vi.mocked(pausarIaPorAtendimentoManual);

beforeEach(() => {
  ops.length = 0;
  conversaExistente = { id: "conv-antiga", contact_id: "contact-antigo" };
  insertDuplicado = false;
  pausa().mockClear();
});

describe("WhatsApp pelo Zernio, conversa que JÁ EXISTE", () => {
  it("⭐ a resposta pelo celular pausa a IA nesta conversa", async () => {
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: saidaPeloCelular() });

    expect(r.status).toBe("ingested");
    expect(pausa()).toHaveBeenCalledTimes(1);
    expect(pausa()).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ organizationId: "org-1", conversationId: "conv-antiga", canal: "zernio" }),
    );
  });

  it("controle: a transmissão do provedor não pausa", async () => {
    await ingestZernioInbound(admin, {
      ...ENTRADA,
      payload: saidaPeloCelular({ sentVia: "broadcast", broadcastId: "6ad297966c6c507b49d6069a" }),
    });
    expect(pausa()).not.toHaveBeenCalled();
  });

  it("controle: o eco do nosso envio já carimbado sai como duplicata e não pausa", async () => {
    insertDuplicado = true;
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: saidaPeloCelular({ sentVia: "api" }) });
    expect(r.status).toBe("duplicate");
    expect(pausa()).not.toHaveBeenCalled();
  });

  it("controle: o eco que chega antes do carimbo (`sentVia = api`) não cala a IA pela própria resposta", async () => {
    const r = await ingestZernioInbound(admin, { ...ENTRADA, payload: saidaPeloCelular({ sentVia: "api" }) });
    expect(r.status).toBe("ingested");
    expect(pausa()).not.toHaveBeenCalled();
  });
});

describe("WhatsApp pelo Zernio, conversa NOVA (a mesma régua)", () => {
  beforeEach(() => {
    conversaExistente = null;
  });

  it("a resposta pelo celular segue pausando", async () => {
    await ingestZernioInbound(admin, { ...ENTRADA, payload: saidaPeloCelular() });
    expect(pausa()).toHaveBeenCalledTimes(1);
    expect(pausa()).toHaveBeenCalledWith(admin, expect.objectContaining({ conversationId: "conv-1" }));
  });

  it("o eco que chega antes do carimbo (`sentVia = api`) não pausa", async () => {
    await ingestZernioInbound(admin, { ...ENTRADA, payload: saidaPeloCelular({ sentVia: "api" }) });
    expect(pausa()).not.toHaveBeenCalled();
  });
});
