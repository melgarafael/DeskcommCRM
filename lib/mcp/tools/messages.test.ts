/**
 * crm_send_whatsapp_message passa pelo freio anti-ban do número antes de
 * enviar, e conta no ledger o envio que saiu (`ritmo-do-envio-por-token.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import type { McpContext } from "@/lib/mcp/types";
import { registrarEnvioPorToken, segurarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";

import { crmSendWhatsappMessage } from "./messages";

const mockedSend = vi.mocked(sendMessageHandler);
const mockedSegurar = vi.mocked(segurarEnvioPorToken);
const mockedRegistrar = vi.mocked(registrarEnvioPorToken);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const ctx = {
  organizationId: ORG_ID,
  role: "agent",
  actor: { type: "api_token", id: "tok" },
  apiTokenId: "tok",
  requestId: "req-1",
  supabase: {},
} as unknown as McpContext;

const input = { conversation_id: CONVERSATION_ID, body: "Oi!", type: "text" } as never;

beforeEach(() => {
  mockedSend.mockReset();
  mockedSegurar.mockReset();
  mockedRegistrar.mockClear();
});

describe("crm_send_whatsapp_message — freio anti-ban do número", () => {
  it("passa pelo freio ANTES de enviar e conta o envio que saiu", async () => {
    const segurado = { channelSessionId: SESSION_ID };
    mockedSegurar.mockResolvedValue(segurado);
    mockedSend.mockResolvedValue({
      id: "m1",
      status: "sent",
      external_id: "x",
      sent_at: "2026-09-22T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await crmSendWhatsappMessage.handler(input, ctx);

    expect(mockedSegurar).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG_ID,
      conversationId: CONVERSATION_ID,
      requestId: "req-1",
    });
    expect(mockedSegurar.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedSend.mock.invocationCallOrder[0]!,
    );
    expect(mockedRegistrar).toHaveBeenCalledWith(expect.anything(), ORG_ID, segurado, "sent");
  });

  it("quando o freio recusa, a mensagem NÃO sai", async () => {
    mockedSegurar.mockRejectedValue(new ApiError(429, "rate_limited", undefined, "req-1"));
    await expect(crmSendWhatsappMessage.handler(input, ctx)).rejects.toBeInstanceOf(ApiError);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedRegistrar).not.toHaveBeenCalled();
  });
});
