import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import type { InboundMessageEvent } from "@/lib/channels/meta/webhook";

const estado = vi.hoisted(() => ({
  insert: null as Record<string, unknown> | null,
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));

vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async () => undefined,
}));

function adminFalso(): SupabaseClient {
  const from = (table: string) => {
    if (table === "channel_sessions") {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({
          data: { id: "session-1", organization_id: "org-1" },
          error: null,
        }),
      };
      return chain;
    }

    if (table === "messages") {
      const terminal = {
        maybeSingle: async () => ({ data: { id: "message-1" }, error: null }),
      };
      return {
        insert: (payload: Record<string, unknown>) => {
          estado.insert = payload;
          return { select: () => terminal };
        },
      };
    }

    throw new Error(`tabela inesperada: ${table}`);
  };

  const rpc = async (name: string, args: Record<string, unknown>) => {
    estado.rpcs.push({ name, args });
    if (name === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
    if (name === "fn_upsert_wa_conversation") {
      return { data: "conversation-1", error: null };
    }
    return { data: null, error: null };
  };

  return { from, rpc } as unknown as SupabaseClient;
}

const EVENTO_COM_MIDIA: InboundMessageEvent = {
  kind: "inbound_message",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  externalId: "wamid.MEDIA",
  from: "5519999999999",
  profileName: "Cliente",
  sentAt: new Date("2026-09-11T12:00:00.000Z"),
  type: "image",
  text: null,
  media: {
    id: "987654321",
    url: null,
    mime: "image/jpeg",
    voice: false,
  },
};

beforeEach(() => {
  estado.insert = null;
  estado.rpcs = [];
});

describe("ingestão oficial de mídia", () => {
  it("guarda um ponteiro recuperável e solicita a persistência dos bytes", async () => {
    const outcome = await ingestMetaInbound(adminFalso(), EVENTO_COM_MIDIA, {
      organizationId: "org-1",
    });

    expect(outcome).toEqual({
      status: "ingested",
      messageId: "message-1",
      conversationId: "conversation-1",
    });
    expect(estado.insert).toMatchObject({
      type: "image",
      media_url: "meta-media:987654321",
      media_mime: "image/jpeg",
    });
    expect(estado.rpcs).toContainEqual({
      name: "emit_event",
      args: {
        p_event_type: "media.persist_requested",
        p_entity_kind: "message",
        p_entity_id: "message-1",
        p_payload: { message_id: "message-1", conversation_id: "conversation-1" },
        p_metadata: { source: "meta_webhook" },
        p_organization_id: "org-1",
      },
    });
  });
});
