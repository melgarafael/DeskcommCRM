/**
 * crm_start_conversation_and_send — a tool compõe duas peças que já existem
 * (`openSharedContactConversation` + `sendMessageHandler`) e não deve
 * reimplementar nenhuma das duas. O teste prova a COMPOSIÇÃO: que a tool
 * passa `channel_session_id`/`contact_id`/`phone_number`/`name` para a
 * abertura de conversa, usa o `conversation_id` que ela devolveu — não um
 * `contact_id` de entrada não resolvido — para o envio, e que a chave de
 * idempotência cobre o PAR (abrir + enviar), não só o envio.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/messaging/open-shared-contact-conversation", () => ({
  openSharedContactConversation: vi.fn(),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/messaging/ritmo-do-envio-por-token", () => ({
  depsDoRitmo: vi.fn(async () => ({})),
  segurarEnvioPorToken: vi.fn(async () => null),
  registrarEnvioPorToken: vi.fn(async () => {}),
}));

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import { registrarEnvioPorToken, segurarEnvioPorToken } from "@/lib/messaging/ritmo-do-envio-por-token";
import { openSharedContactConversation } from "@/lib/messaging/open-shared-contact-conversation";
import type { McpContext } from "@/lib/mcp/types";

import { crmStartConversationAndSend } from "./start-conversation";

const mockedOpen = vi.mocked(openSharedContactConversation);
const mockedSend = vi.mocked(sendMessageHandler);
const mockedSegurar = vi.mocked(segurarEnvioPorToken);
const mockedRegistrar = vi.mocked(registrarEnvioPorToken);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const MESSAGE_ID = "55555555-5555-4555-8555-555555555555";

interface IdemState {
  cached: Record<string, unknown> | null;
  inserts: Array<Record<string, unknown>>;
}

function makeCtx(state: IdemState): McpContext {
  const supabase = {
    from: (table: string) => {
      if (table !== "idempotency_keys") throw new Error(`tabela inesperada: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: state.cached ? { response_body: state.cached } : null,
                    error: null,
                  }),
              }),
            }),
          }),
        }),
        insert: (values: Record<string, unknown>) => {
          state.inserts.push(values);
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return {
    organizationId: ORG_ID,
    role: "manager",
    actor: { type: "user", id: "u1" },
    apiTokenId: "tok",
    requestId: "req-1",
    supabase,
  } as McpContext;
}

beforeEach(() => {
  mockedOpen.mockReset();
  mockedSend.mockReset();
  mockedSegurar.mockReset();
  mockedSegurar.mockResolvedValue(null);
  mockedRegistrar.mockClear();
});

describe("crm_start_conversation_and_send — freio anti-ban do número", () => {
  it("passa pelo freio ANTES de enviar e conta o envio que saiu", async () => {
    const segurado = { channelSessionId: SESSION_ID };
    mockedSegurar.mockResolvedValue(segurado);
    mockedOpen.mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });
    mockedSend.mockResolvedValue({
      id: MESSAGE_ID,
      status: "sent",
      external_id: "wamid.abc",
      sent_at: "2026-09-14T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await crmStartConversationAndSend.handler(
      { channel_session_id: SESSION_ID, contact_id: CONTACT_ID, body: "Oi!", type: "text" } as never,
      makeCtx({ cached: null, inserts: [] }),
    );

    expect(mockedSegurar).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG_ID,
      channelSessionId: SESSION_ID,
      requestId: "req-1",
    });
    expect(mockedSegurar.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedOpen.mock.invocationCallOrder[0]!,
    );
    expect(mockedRegistrar).toHaveBeenCalledWith(expect.anything(), ORG_ID, segurado, "sent");
  });

  it("quando o freio recusa, a conversa NÃO é aberta e a mensagem NÃO sai", async () => {
    mockedSegurar.mockRejectedValue(new ApiError(429, "rate_limited", undefined, "req-1"));
    mockedOpen.mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });

    await expect(
      crmStartConversationAndSend.handler(
        { channel_session_id: SESSION_ID, contact_id: CONTACT_ID, body: "Oi!", type: "text" } as never,
        makeCtx({ cached: null, inserts: [] }),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(mockedRegistrar).not.toHaveBeenCalled();
  });
});

describe("crm_start_conversation_and_send", () => {
  it("recusa sem contact_id e sem phone_number, antes de tocar o banco", async () => {
    const state: IdemState = { cached: null, inserts: [] };
    const parsedInput = {
      channel_session_id: SESSION_ID,
      type: "text" as const,
    };

    await expect(
      crmStartConversationAndSend.handler(parsedInput as never, makeCtx(state)),
    ).rejects.toThrow(/contact_id ou phone_number/);

    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("abre a conversa no canal escolhido e envia usando o conversation_id devolvido", async () => {
    const state: IdemState = { cached: null, inserts: [] };
    mockedOpen.mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });
    mockedSend.mockResolvedValue({
      id: MESSAGE_ID,
      status: "sent",
      external_id: "wamid.abc",
      sent_at: "2026-09-14T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const ctx = makeCtx(state);
    const result = await crmStartConversationAndSend.handler(
      {
        channel_session_id: SESSION_ID,
        phone_number: "+55 11 91234-5678",
        name: "Cliente Novo",
        body: "Oi! Tudo bem?",
        type: "text",
      } as never,
      ctx,
    );

    // A abertura recebe exatamente o que o chamador mandou — inclusive o
    // canal, que é a lacuna que esta tool fecha (o create-contact antigo
    // escolhia sozinho).
    expect(mockedOpen).toHaveBeenCalledWith(ctx.supabase, ORG_ID, {
      channel_session_id: SESSION_ID,
      contact_id: undefined,
      phone_number: "+55 11 91234-5678",
      name: "Cliente Novo",
    });

    // O envio usa o conversation_id que a ABERTURA devolveu — nunca um
    // contact_id de entrada não resolvido nem um id inventado.
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const [, sendCtx, sendInput] = mockedSend.mock.calls[0]!;
    expect(sendCtx).toMatchObject({ organization_id: ORG_ID, requestId: "req-1" });
    expect(sendInput).toMatchObject({ conversation_id: CONVERSATION_ID, body: "Oi! Tudo bem?" });

    expect(result).toEqual({
      contact_id: CONTACT_ID,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      status: "sent",
      external_id: "wamid.abc",
      sent_at: "2026-09-14T12:00:00.000Z",
    });

    // Sem idempotency_key, nada é gravado.
    expect(state.inserts).toHaveLength(0);
  });

  it("com idempotency_key, grava a resposta cobrindo o PAR abrir+enviar", async () => {
    const state: IdemState = { cached: null, inserts: [] };
    mockedOpen.mockResolvedValue({ conversation_id: CONVERSATION_ID, contact_id: CONTACT_ID });
    mockedSend.mockResolvedValue({
      id: MESSAGE_ID,
      status: "queued",
      external_id: null,
      sent_at: "2026-09-14T12:00:00.000Z",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const ctx = makeCtx(state);
    await crmStartConversationAndSend.handler(
      {
        channel_session_id: SESSION_ID,
        contact_id: CONTACT_ID,
        body: "Oi!",
        type: "text",
        idempotency_key: "run-1:step-1",
      } as never,
      ctx,
    );

    expect(state.inserts).toHaveLength(1);
    const gravado = state.inserts[0]!;
    expect(gravado.key).toBe("run-1:step-1");
    expect(gravado.organization_id).toBe(ORG_ID);
    expect(gravado.response_body).toMatchObject({
      contact_id: CONTACT_ID,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
    });
  });

  it("retry com a mesma idempotency_key NÃO abre outra conversa nem manda outra mensagem", async () => {
    const cachedResponse = {
      contact_id: CONTACT_ID,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      status: "sent",
      external_id: "wamid.abc",
      sent_at: "2026-09-14T12:00:00.000Z",
    };
    const state: IdemState = { cached: cachedResponse, inserts: [] };
    const ctx = makeCtx(state);

    const result = await crmStartConversationAndSend.handler(
      {
        channel_session_id: SESSION_ID,
        contact_id: CONTACT_ID,
        body: "Oi!",
        type: "text",
        idempotency_key: "run-1:step-1",
      } as never,
      ctx,
    );

    expect(result).toEqual({ ...cachedResponse, deduplicated: true });
    // O retry nem chega a abrir conversa nem a mandar mensagem — é o ponto
    // inteiro de ter idempotency_key num par abrir+enviar.
    expect(mockedOpen).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
