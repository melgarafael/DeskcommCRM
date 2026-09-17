/**
 * Envio pelo CRM zera unread_count_for_assignee na conversa — espelha outbound
 * da fn_mark_conversation_message, que o handler não chama.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };

describe("sendMessageHandler — unread zera ao responder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("atualiza unread_count_for_assignee = 0 junto com last_outbound_at", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "hash123");

    const { supabase, capturas } = criarDubleDoHandler({
      conversation: {
        id: CONV,
        organization_id: ORG,
        contact_id: CONTACT,
        channel_session_id: SESSION,
        is_group: false,
        group_chat_id: null,
        contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false },
        channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null },
      },
    });

    await sendMessageHandler(
      supabase,
      ctx,
      { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput,
    );

    expect(capturas.patches.conversations?.at(-1)).toMatchObject({
      unread_count_for_assignee: 0,
      last_outbound_at: expect.any(String),
    });
    expect(capturas.patches.contacts?.at(-1)).toMatchObject({
      last_activity_at: expect.any(String),
    });
    // Anti-pattern nº 10 do CLAUDE.md: este handler também é chamado com o
    // client de SERVICE ROLE (agent-engine), que bypassa RLS — a escrita no
    // contato precisa filtrar a organização de fonte confiável, não só o id.
    expect(Object.fromEntries((capturas.filtros.contacts ?? []).map((f) => [f.coluna, f.valor]))).toMatchObject({
      id: expect.any(String),
      organization_id: expect.any(String),
    });
  });
});
