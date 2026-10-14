/**
 * crm_send_whatsapp_message passa pelo freio anti-ban do número antes de
 * enviar, e conta no ledger o envio que saiu (`ritmo-do-envio-por-token.ts`).
 *
 * A segunda metade (issue #2812, item 3): sem `conversation_id`, a tool aceita
 * `phone_number`, resolve o número da organização pela regra da casa
 * (`sessaoProntaParaEnvio`) e abre/reaproveita a conversa pelo MESMO helper da
 * criação de conversa (`openSharedContactConversation`) antes de enviar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));
vi.mock("@/lib/automation/start-conversation", () => ({
  sessaoProntaParaEnvio: vi.fn(async () => null),
}));
vi.mock("@/lib/messaging/open-shared-contact-conversation", () => ({
  openSharedContactConversation: vi.fn(),
}));

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { ApiError } from "@/lib/api/types";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import type { McpContext } from "@/lib/mcp/types";
import { registrarEnvioPorToken, segurarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";

import { crmSendWhatsappMessage } from "./messages";

const mockedSend = vi.mocked(sendMessageHandler);
const mockedSegurar = vi.mocked(segurarEnvioPorToken);
const mockedRegistrar = vi.mocked(registrarEnvioPorToken);
const mockedSessao = vi.mocked(sessaoProntaParaEnvio);
const mockedAbrir = vi.mocked(openSharedContactConversation);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const CONVERSATION_ABERTA = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "66666666-6666-4666-8666-666666666666";
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
const inputTelefone = { phone_number: "+5511999998888", body: "Oi!", type: "text" } as never;

function retornoEnvio() {
  return {
    id: "m1",
    status: "sent",
    external_id: "x",
    sent_at: "2026-09-22T12:00:00.000Z",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  mockedSend.mockReset();
  mockedSegurar.mockReset();
  mockedRegistrar.mockClear();
  mockedSessao.mockReset();
  mockedAbrir.mockReset();
});

describe("crm_send_whatsapp_message — freio anti-ban do número", () => {
  it("passa pelo freio ANTES de enviar e conta o envio que saiu", async () => {
    const segurado = { channelSessionId: SESSION_ID };
    mockedSegurar.mockResolvedValue(segurado);
    mockedSend.mockResolvedValue(retornoEnvio());

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

describe("crm_send_whatsapp_message — abrir a conversa pelo telefone (#2812)", () => {
  beforeEach(() => {
    mockedSend.mockResolvedValue(retornoEnvio());
  });

  it("com conversation_id, NÃO abre conversa — só envia", async () => {
    mockedSegurar.mockResolvedValue({ channelSessionId: SESSION_ID });

    const r = (await crmSendWhatsappMessage.handler(input, ctx)) as Record<string, unknown>;

    expect(mockedAbrir).not.toHaveBeenCalled();
    expect(mockedSessao).not.toHaveBeenCalled();
    expect(r).not.toHaveProperty("conversation_id");
    expect(r).not.toHaveProperty("contato_aberto_por_telefone");
  });

  it("com phone_number, resolve o número da casa, abre a conversa e envia por ela", async () => {
    mockedSessao.mockResolvedValue(SESSION_ID);
    mockedSegurar.mockResolvedValue({ channelSessionId: SESSION_ID });
    mockedAbrir.mockResolvedValue({ conversation_id: CONVERSATION_ABERTA, contact_id: CONTACT_ID });

    const r = (await crmSendWhatsappMessage.handler(inputTelefone, ctx)) as Record<string, unknown>;

    // O número sai da regra da casa, não de auto-seleção inventada aqui.
    expect(mockedSessao).toHaveBeenCalledWith(ctx.supabase, ORG_ID);
    // O freio é aplicado na SESSÃO, antes de abrir a conversa.
    expect(mockedSegurar).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG_ID,
      channelSessionId: SESSION_ID,
      requestId: "req-1",
    });
    expect(mockedAbrir).toHaveBeenCalledWith(ctx.supabase, ORG_ID, {
      channel_session_id: SESSION_ID,
      phone_number: "+5511999998888",
    });
    expect(mockedAbrir.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedSend.mock.invocationCallOrder[0]!,
    );
    // O envio usa a conversa que a abertura devolveu.
    expect(mockedSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organization_id: ORG_ID, requestId: "req-1" }),
      expect.objectContaining({ conversation_id: CONVERSATION_ABERTA }),
    );
    expect(r).toMatchObject({
      conversation_id: CONVERSATION_ABERTA,
      contact_id: CONTACT_ID,
      contato_aberto_por_telefone: true,
    });
  });

  it("sem telefone e sem conversation_id, recusa e não chama o handler", async () => {
    await expect(
      crmSendWhatsappMessage.handler({ body: "Oi!", type: "text" } as never, ctx),
    ).rejects.toBeInstanceOf(ApiError);
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedAbrir).not.toHaveBeenCalled();
  });

  it("telefone inválido é recusado com motivo, sem enviar", async () => {
    mockedSessao.mockResolvedValue(SESSION_ID);
    mockedSegurar.mockResolvedValue({ channelSessionId: SESSION_ID });
    mockedAbrir.mockRejectedValue(new Error("invalid_phone"));

    await expect(crmSendWhatsappMessage.handler(inputTelefone, ctx)).rejects.toMatchObject({
      status: 422,
      code: "invalid_phone",
    });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("contato pessoal recusa ANTES de enviar", async () => {
    mockedSessao.mockResolvedValue(SESSION_ID);
    mockedSegurar.mockResolvedValue({ channelSessionId: SESSION_ID });
    mockedAbrir.mockRejectedValue(new Error("contact_personal"));

    const r = (await crmSendWhatsappMessage.handler(inputTelefone, ctx)) as Record<string, unknown>;

    expect(r).toMatchObject({ permitido: false, motivo: "contato_pessoal" });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("quando o freio recusa no caminho do telefone, a conversa NÃO é aberta", async () => {
    mockedSessao.mockResolvedValue(SESSION_ID);
    mockedSegurar.mockRejectedValue(new ApiError(429, "rate_limited", undefined, "req-1"));

    await expect(crmSendWhatsappMessage.handler(inputTelefone, ctx)).rejects.toBeInstanceOf(ApiError);
    expect(mockedAbrir).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
