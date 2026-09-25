import { createHmac } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Coexistência: o que a empresa manda pelo app WhatsApp Business entra no CRM.
 *
 * A Meta entrega essas mensagens no campo `smb_message_echoes`, que o parser
 * descartava — a conversa ficava sem as respostas dadas pelo celular e o agente
 * respondia por cima de um humano. O formato do payload é o da referência da
 * Meta (webhooks/reference/smb_message_echoes).
 */

const estado = vi.hoisted(() => ({
  insert: null as Record<string, unknown> | null,
  erroInsert: null as { code: string; message: string } | null,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  marcacoes: [] as Array<Record<string, unknown>>,
  pausas: [] as Array<Record<string, unknown>>,
  auditorias: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: async (_a: unknown, args: Record<string, unknown>) => {
    estado.marcacoes.push(args);
  },
}));
vi.mock("@/lib/escalacao/atendimento-manual", () => ({
  pausarIaPorAtendimentoManual: async (_a: unknown, input: Record<string, unknown>) => {
    estado.pausas.push(input);
    return true;
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    estado.auditorias.push(entrada);
  },
}));

import { ingestMetaEcho } from "@/lib/channels/meta/ingest";
import { parseMetaWebhook, type OutboundEchoEvent } from "@/lib/channels/meta/webhook";

function envelopeDeEcos(ecos: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "smb_message_echoes",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511300000000", phone_number_id: "phone-1" },
              message_echoes: ecos,
            },
          },
        ],
      },
    ],
  };
}

function adminFalso(): SupabaseClient {
  const from = (table: string) => {
    if (table === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: { id: "session-1", organization_id: "org-1" }, error: null }),
      };
      return chain;
    }
    if (table === "messages") {
      return {
        insert: (payload: Record<string, unknown>) => {
          estado.insert = payload;
          return {
            select: () => ({
              maybeSingle: async () =>
                estado.erroInsert
                  ? { data: null, error: estado.erroInsert }
                  : { data: { id: "message-1" }, error: null },
            }),
          };
        },
      };
    }
    throw new Error(`tabela inesperada: ${table}`);
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ name, args });
    if (name === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
    if (name === "fn_upsert_wa_conversation") return { data: "conversation-1", error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const ECO_TEXTO: OutboundEchoEvent = {
  kind: "outbound_echo",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  externalId: "wamid.ECO1",
  to: "5519999999999",
  sentAt: new Date("2026-09-24T12:00:00.000Z"),
  type: "text",
  text: "Já te respondo pelo celular",
  media: null,
};

beforeEach(() => {
  estado.insert = null;
  estado.erroInsert = null;
  estado.rpcs = [];
  estado.marcacoes = [];
  estado.pausas = [];
  estado.auditorias = [];
});

describe("parser: smb_message_echoes vira evento de saída", () => {
  it("texto enviado pelo app vira `outbound_echo` com o cliente em `to`", () => {
    const eventos = parseMetaWebhook(
      envelopeDeEcos([
        {
          from: "5511300000000",
          to: "5519999999999",
          id: "wamid.ECO1",
          timestamp: "1790000000",
          type: "text",
          text: { body: "Olá, tudo bem?" },
        },
      ]) as never,
    );
    expect(eventos).toEqual([
      {
        kind: "outbound_echo",
        wabaId: "waba-1",
        phoneNumberId: "phone-1",
        externalId: "wamid.ECO1",
        to: "5519999999999",
        sentAt: new Date(1790000000 * 1000),
        type: "text",
        text: "Olá, tudo bem?",
        media: null,
      },
    ]);
  });

  it("mídia enviada pelo app traz o ponteiro e a legenda como texto", () => {
    const [e] = parseMetaWebhook(
      envelopeDeEcos([
        {
          to: "5519999999999",
          id: "wamid.ECO2",
          timestamp: "1790000000",
          type: "image",
          image: { id: "media-9", mime_type: "image/jpeg", caption: "segue a foto" },
        },
      ]) as never,
    );
    expect(e).toMatchObject({
      kind: "outbound_echo",
      type: "image",
      text: "segue a foto",
      media: { id: "media-9", mime: "image/jpeg", url: null, voice: false },
    });
  });

  it("cartão de contato (`contacts`) vira `contact` com o nome, como na recebida", () => {
    // O CHECK de `messages.type` aceita `contact`, não `contacts`: sem o mapeamento
    // o insert falharia e a IA não pausaria.
    const [e] = parseMetaWebhook(
      envelopeDeEcos([
        {
          to: "5519999999999",
          id: "wamid.ECO3",
          timestamp: "1790000000",
          type: "contacts",
          contacts: [{ name: { formatted_name: "Ana Souza" }, phones: [{ phone: "+55 11 98888-7777" }] }],
        },
      ]) as never,
    );
    expect(e).toMatchObject({
      kind: "outbound_echo",
      type: "contact",
      text: "Ana Souza",
      sharedContact: { name: "Ana Souza" },
      media: null,
    });
  });

  it("`revoke`, `edit` e eco sem destinatário ficam de fora", () => {
    const eventos = parseMetaWebhook(
      envelopeDeEcos([
        { to: "5519999999999", id: "wamid.R", timestamp: "1", type: "revoke", revoke: {} },
        { to: "5519999999999", id: "wamid.E", timestamp: "1", type: "edit", edit: {} },
        { id: "wamid.SEM_TO", timestamp: "1", type: "text", text: { body: "x" } },
      ]) as never,
    );
    expect(eventos).toEqual([]);
  });
});

describe("ingestão do eco", () => {
  it("grava como saída de humano fora do CRM, na conversa do cliente, e pausa a IA", async () => {
    const r = await ingestMetaEcho(adminFalso(), ECO_TEXTO, { organizationId: "org-1" });

    expect(r).toEqual({ status: "ingested", messageId: "message-1", conversationId: "conversation-1" });
    expect(estado.insert).toMatchObject({
      organization_id: "org-1",
      channel_session_id: "session-1",
      contact_id: "contact-1",
      conversation_id: "conversation-1",
      direction: "outbound",
      status: "sent",
      sent_via: "external_device",
      type: "text",
      body: "Já te respondo pelo celular",
      external_id: "wamid.ECO1",
      metadata: { from_business_app: true },
    });
    // O contato é o DESTINATÁRIO, e o eco não batiza ninguém.
    const contato = estado.rpcs.find((c) => c.name === "fn_upsert_wa_contact");
    expect(contato?.args).toMatchObject({ p_chat_id: "5519999999999", p_notify: null });
    expect(estado.marcacoes).toEqual([
      expect.objectContaining({ conversationId: "conversation-1", direction: "outbound" }),
    ]);
    expect(estado.pausas).toEqual([
      { organizationId: "org-1", conversationId: "conversation-1", canal: "meta" },
    ]);
    expect(estado.auditorias).toEqual([
      expect.objectContaining({ action: "message.sent", organizationId: "org-1" }),
    ]);
  });

  it("re-entrega (23505) sai como duplicata e NÃO pausa a IA de novo", async () => {
    estado.erroInsert = { code: "23505", message: "duplicate key" };

    const r = await ingestMetaEcho(adminFalso(), ECO_TEXTO, { organizationId: "org-1" });

    expect(r).toEqual({ status: "duplicate" });
    expect(estado.pausas).toEqual([]);
    expect(estado.marcacoes).toEqual([]);
  });

  it("cartão do eco grava `contact` com o nome no corpo e o cartão no metadata", async () => {
    const cartao = { name: "Ana Souza", phone_number: "+55 11 98888-7777" };
    await ingestMetaEcho(
      adminFalso(),
      { ...ECO_TEXTO, type: "contact", text: "Ana Souza", sharedContact: cartao },
      { organizationId: "org-1" },
    );
    expect(estado.insert).toMatchObject({
      type: "contact",
      body: "Ana Souza",
      metadata: { from_business_app: true, shared_contact: cartao },
    });
    expect(estado.pausas).toHaveLength(1);
  });

  it("mídia do eco pede a persistência dos bytes, como na recebida", async () => {
    await ingestMetaEcho(
      adminFalso(),
      { ...ECO_TEXTO, type: "image", text: null, media: { id: "media-9", url: null, mime: "image/jpeg", voice: false } },
      { organizationId: "org-1" },
    );
    expect(estado.insert).toMatchObject({ media_url: "meta-media:media-9", media_mime: "image/jpeg" });
    expect(estado.rpcs).toContainEqual(
      expect.objectContaining({
        name: "emit_event",
        args: expect.objectContaining({ p_event_type: "media.persist_requested", p_entity_id: "message-1" }),
      }),
    );
  });
});

describe("a rota do webhook oficial entrega o eco à ingestão", () => {
  it("eco bem assinado: 200, e o desfecho aparece como `eco:*`", async () => {
    vi.resetModules();
    const segredo = "app-secret-de-teste";
    vi.stubEnv("META_APP_SECRET", segredo);
    const ecosIngeridos: unknown[] = [];

    vi.doMock("@/lib/channels/meta/session", () => ({
      metaSessionByWebhookToken: async () => ({ id: "sess-1", organizationId: "org-1", wabaId: "waba-1" }),
    }));
    vi.doMock("@/lib/channels/meta/app", () => ({
      appDaMeta: async () => ({ appSecret: segredo, verifyToken: null }),
    }));
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
    vi.doMock("@/lib/channels/meta/ingest", () => ({
      ingestMetaInbound: async () => ({ status: "ingested" }),
      ingestMetaEcho: async (_a: unknown, e: unknown) => {
        ecosIngeridos.push(e);
        return { status: "ingested" };
      },
    }));

    const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
    const cru = JSON.stringify(
      envelopeDeEcos([
        { to: "5519999999999", id: "wamid.ECO1", timestamp: "1790000000", type: "text", text: { body: "oi" } },
      ]),
    );
    const res = await POST(
      {
        text: async () => cru,
        headers: new Headers({
          "x-hub-signature-256": `sha256=${createHmac("sha256", segredo).update(cru, "utf8").digest("hex")}`,
        }),
      } as never,
      { params: Promise.resolve({ token: "t" }) } as never,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1, outcomes: ["eco:ingested"] });
    expect(ecosIngeridos).toHaveLength(1);
    vi.unstubAllEnvs();
  });
});
