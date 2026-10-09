/**
 * A PORTA DE SAÍDA RECUSA ORGANIZAÇÃO PARADA.
 *
 * `sendMessageHandler` é a saída de ~20 chamadores (tela, MCP, token,
 * automação, campanha, agente). O gate e os filtros dos crons barram antes;
 * este assert é a última porta — e é ele que fecha a corrida de quem passou
 * pelo gate um instante antes da suspensão.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const USER = "55555555-5555-4555-8555-555555555555";
const conversa = {
  id: CONV,
  organization_id: ORG,
  contact_id: "33333333-3333-4333-8333-333333333333",
  channel_session_id: "44444444-4444-4444-8444-444444444444",
  is_group: false,
  group_chat_id: null,
  contacts: { phone_number: "+5531999998888", wa_identity: null, is_blocked: false },
  channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null },
};
const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };
const texto = { conversation_id: CONV, type: "text", body: "oi" } as SendMessageInput;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendMessageHandler × organização parada", () => {
  it.each(["suspended", "redacted", "archived"])(
    "org %s → 403 org_suspended, nenhuma linha nasce e nada sai",
    async (status) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { supabase, mensagens } = criarDubleDoHandler({ conversation: conversa, organizacao: { settings: {}, status } });
      const erro = await sendMessageHandler(supabase, ctx, texto).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(OrgNaoOperanteError);
      expect(erro).toMatchObject({ status: 403, code: "org_suspended", terminal: true });
      expect(mensagens).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("org active segue o caminho de sempre (controle)", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "");
    vi.stubEnv("WAHA_API_KEY", "");
    const { supabase } = criarDubleDoHandler({ conversation: conversa, organizacao: { settings: {}, status: "active" } });
    const msg = await sendMessageHandler(supabase, ctx, texto);
    expect(msg.status).toBe("queued");
  });
});
