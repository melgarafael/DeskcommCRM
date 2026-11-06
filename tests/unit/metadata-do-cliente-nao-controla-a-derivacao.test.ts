/**
 * O CLIENTE NÃO ESCREVE AS CHAVES QUE O SERVIDOR CONFIA NA DERIVAÇÃO DE MÍDIA.
 *
 * `POST /api/v1/messages` copia `input.metadata` para a linha. Três chaves de
 * `messages.metadata` são do servidor e o servidor confia nelas:
 *
 *   - `derivacao_pedida_em` — o dreno do turno a converte em data
 *     (`::timestamptz`) na consulta de espera da mídia. Um texto que o Postgres
 *     não converte derrubava a consulta e calava a IA da empresa inteira; uma
 *     data futura segurava o turno;
 *   - `derivacao_adiada` — o cron `media-leitura-adiada` e o dreno reabrem a
 *     linha e pedem a visão PAGA para ela;
 *   - `media_derived_motivo` — o diagnóstico que os workers gravam.
 *
 * O servidor decide; o cliente nunca forja — como o handler já faz com o
 * emissor (`ai_actor_name` vem depois de `input.metadata`). O resto do
 * `metadata` do cliente continua passando.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            is: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          maybeSingle: async () => ({ data: null, error: null }),
        }),
        maybeSingle: async () => ({ data: null, error: null }),
      }),
      maybeSingle: async () => ({ data: null, error: null }),
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const CONTA = "6a3572a15f7d1751ab117832";
const THREAD = "6a76a2dc4b8fe115e5f6c300";

const conversa = {
  id: CONV,
  organization_id: ORG,
  contact_id: CONTACT,
  channel_session_id: SESSION,
  is_group: false,
  group_chat_id: null,
  provider_conversation_id: THREAD,
  contacts: { phone_number: "+595991733685", wa_identity: null, wa_lid: null, is_blocked: false },
  channel_sessions: {
    provider: "zernio",
    waha_session_name: null,
    meta_phone_number_id: null,
    zernio_account_id: CONTA,
    status: "WORKING",
    archived_at: null,
  },
};

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USER },
  requestId: "req-1",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("metadata do cliente não controla a derivação de mídia", () => {
  it("as chaves da derivação não chegam à linha; o resto do metadata passa", async () => {
    vi.stubEnv("ZERNIO_ACCOUNT_ID", CONTA);
    vi.stubEnv("ZERNIO_API_KEY", "sk_env");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { messageId: "wamid.OK" } }),
      })),
    );
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa,
      organizacao: { settings: {}, status: "active" },
    });

    await sendMessageHandler(supabase, ctx, {
      conversation_id: CONV,
      type: "text",
      body: "oi",
      metadata: {
        derivacao_pedida_em: "lixo-que-o-postgres-nao-converte",
        derivacao_adiada: "sem_leitor",
        media_derived_motivo: "forjado",
        campanha: "black-friday",
      },
    } as SendMessageInput);

    const gravado = capturas.inserts.messages!.at(-1)?.["metadata"] as Record<string, unknown>;
    expect(gravado).not.toHaveProperty("derivacao_pedida_em");
    expect(gravado).not.toHaveProperty("derivacao_adiada");
    expect(gravado).not.toHaveProperty("media_derived_motivo");
    expect(gravado, "o metadata legítimo do cliente continua").toHaveProperty("campanha", "black-friday");
  });
});
