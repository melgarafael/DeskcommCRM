/**
 * Envio pelo CRM zera unread_count_for_assignee na conversa — espelha outbound
 * da fn_mark_conversation_message, que o handler não chama.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `.eq()` do duble: encadeável E aguardável. Precisa de nome próprio porque a
 * função se referencia dentro do próprio inicializador — sem a anotação, o
 * `tsc --noEmit` do `verify` reprova com TS7022 (implicit any).
 */
interface Encadeavel extends PromiseLike<{ error: null }> {
  eq: (col: string, val: unknown) => Encadeavel;
}

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

function makeSupabase(conversation: Record<string, unknown>) {
  let conversationPatch: Record<string, unknown> | null = null;
  let contactPatch: Record<string, unknown> | null = null;
  const contactFilters: Record<string, unknown> = {};

  const client = {
    from(table: string) {
      if (table === "conversations") {
        // Encadeável SEM LIMITE: a consulta da conversa filtra por id E por
        // `organization_id` — este handler também roda com o client de service
        // role, que bypassa RLS, e lá o filtro é a única proteção.
        const cadeiaConv: Record<string, unknown> = {
          eq: () => cadeiaConv,
          maybeSingle: async () => ({ data: conversation, error: null }),
        };
        return {
          select: () => cadeiaConv,
          update: (patch: Record<string, unknown>) => {
            conversationPatch = patch;
            return { eq: async () => ({ error: null }) };
          },
        };
      }
      if (table === "contacts") {
        return {
          update: (patch: Record<string, unknown>) => {
            contactPatch = patch;
            // `.eq()` encadeável E aguardável: o carimbo do contato filtra por
            // `id` E por `organization_id` (o handler também roda com o client
            // de service role, que bypassa RLS). Um duble que só aceita um
            // `.eq()` faz o segundo estourar `.eq is not a function` — e um que
            // ignora o encadeamento deixaria o filtro de tenant sumir sem
            // ninguém notar. Por isso ele REGISTRA os filtros.
            const encadeavel = (): Encadeavel => ({
              eq: (col: string, val: unknown) => {
                contactFilters[col] = val;
                return encadeavel();
              },
              then: (resolve) => Promise.resolve({ error: null }).then(resolve),
            });
            return encadeavel();
          },
        };
      }
      if (table === "messages") {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => ({
                data: { id: "msg-1", external_id: null, ack: null, error_code: null, error_message: null, ...row },
                error: null,
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () => ({ data: { status: "sent" }, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada: ${table}`);
    },
    rpc: async () => ({ error: null }),
    getConversationPatch: () => conversationPatch,
    getContactPatch: () => contactPatch,
    getContactFilters: () => contactFilters,
  };

  return client as unknown as SupabaseClient & {
    getConversationPatch: () => Record<string, unknown> | null;
    getContactPatch: () => Record<string, unknown> | null;
    getContactFilters: () => Record<string, unknown>;
  };
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };

describe("sendMessageHandler — unread zera ao responder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("atualiza unread_count_for_assignee = 0 junto com last_outbound_at", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "hash123");

    const supabase = makeSupabase({
      id: CONV,
      organization_id: ORG,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      is_group: false,
      group_chat_id: null,
      contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false },
      channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null },
    });

    await sendMessageHandler(
      supabase,
      ctx,
      { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput,
    );

    expect(supabase.getConversationPatch()).toMatchObject({
      unread_count_for_assignee: 0,
      last_outbound_at: expect.any(String),
    });
    expect(supabase.getContactPatch()).toMatchObject({
      last_activity_at: expect.any(String),
    });
    // Anti-pattern nº 10 do CLAUDE.md: este handler também é chamado com o
    // client de SERVICE ROLE (agent-engine), que bypassa RLS — a escrita no
    // contato precisa filtrar a organização de fonte confiável, não só o id.
    expect(supabase.getContactFilters()).toMatchObject({
      id: expect.any(String),
      organization_id: expect.any(String),
    });
  });
});
