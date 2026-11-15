/**
 * O handler de mensagens grava NA LINHA `failed` a natureza da recusa.
 *
 * É o elo entre o adapter (que sabe se o provedor recusou o conteúdo ou só
 * caiu) e o motor do agente (que decide se re-tenta o turno): o `send_ledger`
 * lê `metadata.falha_de_envio` da própria mensagem. Sem este elo, a recusa
 * definitiva chegava ao motor como um `failed` qualquer — e a fila re-tentava.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { FalhaDeEnvioDoCanal } from "@/lib/channels/falha-de-envio";
import { deriveActor } from "@/lib/mcp/auth";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

/** O que o `send` do adapter faz neste caso — trocado por teste. */
const envio: { lanca: unknown } = { lanca: null };
vi.mock("@/lib/channels", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/channels")>();
  return {
    ...real,
    getAdapter: (provider: Parameters<typeof real.getAdapter>[0]) => ({
      ...real.getAdapter(provider),
      send: async () => {
        throw envio.lanca;
      },
    }),
  };
});

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: deriveActor(["mcp:write"], "77777777-7777-4777-8777-777777777777"),
  requestId: "req-falha",
};

function conversa() {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    provider_conversation_id: null,
    last_inbound_at: new Date(Date.now() - 3_600_000).toISOString(),
    contacts: { phone_number: "+5531999998888", wa_identity: null, wa_lid: null, is_blocked: false },
    channel_sessions: {
      id: SESSION,
      organization_id: ORG,
      provider: "meta_cloud",
      waha_session_name: null,
      status: "WORKING",
      archived_at: null,
    },
  };
}

async function enviaComFalha(lanca: unknown) {
  vi.stubEnv("META_PHONE_NUMBER_ID", "1103328999528818");
  vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok");
  envio.lanca = lanca;
  const { supabase, capturas } = criarDubleDoHandler({ conversation: conversa() });
  const msg = (await sendMessageHandler(supabase, ctx, {
    conversation_id: CONV,
    type: "text",
    body: "oi",
  } as SendMessageInput)) as { status: string; metadata?: Record<string, unknown> | null };
  const patchDaFalha = capturas.patches.messages!.find((p) => (p as { status?: string }).status === "failed") as
    | { metadata?: Record<string, unknown> }
    | undefined;
  return { msg, patchDaFalha };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a natureza da recusa chega à linha `failed`", () => {
  it("⭐ recusa definitiva do adapter (4xx): `falha_de_envio.natureza = permanente`, com o status", async () => {
    const { msg, patchDaFalha } = await enviaComFalha(
      new FalhaDeEnvioDoCanal("O provedor não concluiu a operação (HTTP 400).", "permanente", 400),
    );
    expect(msg.status).toBe("failed");
    expect(patchDaFalha?.metadata?.falha_de_envio).toEqual({ natureza: "permanente", status_http: 400 });
  });

  it("queda de rede / erro sem classificação: `transitoria` — o motor re-tenta, como antes", async () => {
    const { msg, patchDaFalha } = await enviaComFalha(new TypeError("fetch failed"));
    expect(msg.status).toBe("failed");
    expect(patchDaFalha?.metadata?.falha_de_envio).toEqual({ natureza: "transitoria" });
  });
});
