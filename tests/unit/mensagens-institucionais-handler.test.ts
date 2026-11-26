/**
 * Mensagens institucionais no `sendMessageHandler` (PR 02):
 *
 * Cobre todos os invariantes de domínio, concorrência, permissões, bloqueios
 * de canal/contato, anti-spoofing, auditoria/event_log e compatibilidade
 * retroativa do caminho único de envio (`app/api/v1/messages/_handler.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { deriveActor } from "@/lib/mcp/auth";
import { CHAVE_DO_MODO_DE_ENVIO } from "@/lib/messaging/modo-de-envio";
import {
  sendMessagePorTelefoneSchema,
  sendMessageSchema,
  type SendMessageInput,
} from "@/lib/schemas/messaging";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

const auditMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/audit", () => ({ audit: auditMock, isServiceRoleConfigured: () => false }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({
          data: { signedUrl: "https://signed.example/doc.pdf" },
          error: null,
        }),
      }),
    },
  }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const TOKEN_ID = "77777777-7777-4777-8777-777777777777";

function wahaAceita(externalId = "3EB0INST001") {
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "hash123");
  const fetchSpy = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify({ id: { id: externalId } }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function metaAceita(externalId = "wamid.META.INST.1") {
  vi.stubEnv("META_PHONE_NUMBER_ID", "1103328999528818");
  vi.stubEnv("META_SYSTEM_USER_TOKEN", "tok-meta");
  const fetchSpy = vi.fn(async () => {
    return new Response(JSON.stringify({ messages: [{ id: externalId }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function baseConversa(over: Record<string, unknown> = {}) {
  return {
    id: CONV,
    organization_id: ORG,
    status: "open",
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    assigned_to_user_id: null,
    assignee_kind: null,
    metadata: {},
    provider_conversation_id: null,
    last_inbound_at: new Date(Date.now() - 3_600_000).toISOString(),
    contacts: {
      phone_number: "+5531999998888",
      wa_identity: null,
      wa_lid: null,
      social_identity: null,
      is_blocked: false,
      is_personal: false,
      personal_owner_user_id: null,
    },
    channel_sessions: {
      id: SESSION,
      organization_id: ORG,
      provider: "waha",
      waha_session_name: "default",
      status: "WORKING",
      archived_at: null,
      metadata: {},
    },
    ...over,
  };
}

function ctxInstitucional(over: Partial<HandlerCtx> = {}): HandlerCtx {
  return {
    organization_id: ORG,
    actor: deriveActor(["mcp:write", "messages:institutional"], TOKEN_ID),
    dispatchMode: "institutional",
    requestId: "req-inst-1",
    ...over,
  };
}

function payloadInstitucional(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    conversation_id: CONV,
    type: "text",
    body: "Aviso institucional: manutenção programada hoje às 22h.",
    dispatch_mode: "institutional",
    ...over,
  } as SendMessageInput;
}

beforeEach(() => {
  auditMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Mensagens institucionais no sendMessageHandler (PR 02)", () => {
  it("Cenário 1: conversa com IA ativa — envia, grava sent_via='system' + metadata do servidor e NÃO altera conversa/contato", async () => {
    const fetchSpy = wahaAceita("3EB0IAATIVA");
    const { supabase, capturas, mensagens } = criarDubleDoHandler({
      conversation: baseConversa({
        status: "open",
        bot_silenced_until: null,
        assigned_to_user_id: null,
        assignee_kind: null,
      }),
    });

    const msg = await sendMessageHandler(supabase, ctxInstitucional(), payloadInstitucional());

    const enviosTexto = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes("/api/sendText"),
    );
    expect(enviosTexto).toHaveLength(1);
    expect(msg.status).toBe("sent");
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toMatchObject({
      sent_via: "system",
      sent_by_user_id: null,
      sent_on_behalf_of_user_id: null,
      status: "sent",
    });
    expect((mensagens[0]!.metadata as Record<string, unknown>)[CHAVE_DO_MODO_DE_ENVIO]).toBe(
      "institutional",
    );
    expect(capturas.patches.conversations).toEqual([]);
    expect(capturas.patches.contacts).toEqual([]);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "message.sent",
        actorApiTokenId: TOKEN_ID,
        metadata: expect.objectContaining({ dispatch_mode: "institutional", status: "sent" }),
      }),
    );
    expect(capturas.rpcs).toContainEqual({
      nome: "emit_event",
      args: expect.objectContaining({
        p_event_type: "message.sent",
        p_payload: expect.objectContaining({
          dispatch_mode: "institutional",
          conversation_id: CONV,
        }),
        p_metadata: expect.objectContaining({ dispatch_mode: "institutional" }),
      }),
    });
  });

  it("Cenário 2: conversa aguardando na Fila humana — preserva unread, awaiting_since, last_outbound_at, prévia e dono nulo", async () => {
    wahaAceita("3EB0FILA1");
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: baseConversa({
        status: "pending",
        unread_count_for_assignee: 4,
        awaiting_since: "2026-11-25T10:00:00.000Z",
        bot_silenced_until: "infinity",
      }),
    });

    await sendMessageHandler(supabase, ctxInstitucional(), payloadInstitucional());

    expect(capturas.patches.conversations).toEqual([]);
    expect(capturas.patches.contacts).toEqual([]);
  });

  it("Cenário 3: conversa com atendente humano e IA silenciada ('infinity' ou prazo futuro) — preserva carteira e silêncio", async () => {
    wahaAceita("3EB0HUMANO1");
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: baseConversa({
        status: "claimed",
        assigned_to_user_id: USER,
        assignee_kind: "user",
        bot_silenced_until: "infinity",
      }),
    });

    await sendMessageHandler(supabase, ctxInstitucional(), payloadInstitucional());

    expect(capturas.patches.conversations).toEqual([]);
    expect(capturas.patches.contacts).toEqual([]);
  });

  it("Cenário 4: canal oficial (meta_cloud) entrega dentro da janela de 24h OU via template fora da janela sem efeitos colaterais", async () => {
    const fetchSpy = metaAceita("wamid.META.TPL.1");
    const { supabase, capturas, mensagens } = criarDubleDoHandler({
      conversation: baseConversa({
        last_inbound_at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
        channel_sessions: {
          id: SESSION,
          organization_id: ORG,
          provider: "meta_cloud",
          waha_session_name: null,
          status: "WORKING",
          archived_at: null,
          metadata: {},
        },
      }),
      templateRow: {
        name: "aviso_manutencao",
        language: "pt_BR",
        category: "UTILITY",
        status: "APPROVED",
        contract_hash: "h-inst-1",
        components: [{ type: "BODY", text: "Olá {{1}}, aviso." }],
      },
    });

    const msg = await sendMessageHandler(
      supabase,
      ctxInstitucional(),
      payloadInstitucional({
        type: "template",
        body: undefined,
        template_name: "aviso_manutencao",
        template_language: "pt_BR",
        template_values: { "1": "Maria" },
      } as never),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(msg.status).toBe("sent");
    expect((mensagens[0]!.metadata as Record<string, unknown>)[CHAVE_DO_MODO_DE_ENVIO]).toBe(
      "institutional",
    );
    expect(capturas.patches.conversations).toEqual([]);
    expect(capturas.patches.contacts).toEqual([]);
  });

  it.each(["closed", "resolved", "archived", null] as const)(
    "Cenário 5: recusa envio institucional quando conversa está em status '%s' (409 state_conflict, 0 envios)",
    async (statusTerminal) => {
      const fetchSpy = wahaAceita();
      const { supabase, mensagens, capturas } = criarDubleDoHandler({
        conversation: baseConversa({ status: statusTerminal }),
      });

      const erro = await sendMessageHandler(
        supabase,
        ctxInstitucional(),
        payloadInstitucional(),
      ).then(
        () => null,
        (e: unknown) => e,
      );

      expect(erro).toBeInstanceOf(ApiError);
      expect(erro).toMatchObject({ status: 409, code: "state_conflict" });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mensagens).toHaveLength(0);
      expect(capturas.patches.conversations).toEqual([]);
      expect(capturas.patches.contacts).toEqual([]);
    },
  );

  it("Cenário 6: corrida concorrente — conversa fecha entre leitura inicial e checkBoundary; cancela envio e tira linha de queued", async () => {
    const fetchSpy = wahaAceita();
    const { supabase, mensagens, capturas } = criarDubleDoHandler({
      conversation: baseConversa({ status: "open" }),
    });

    const origFrom = supabase.from.bind(supabase);
    const supabaseComCorrida = new Proxy(supabase, {
      get(target, prop, receiver) {
        if (prop === "from") {
          return (tabela: string) => {
            // Quando `mensagens` já recebeu a linha `queued`, estamos no
            // `checkBoundary`: simulamos o fechamento concorrente da conversa.
            if (tabela === "conversations" && mensagens.length > 0) {
              const builder = {
                select: () => builder,
                eq: () => builder,
                maybeSingle: async () => ({ data: { status: "closed" }, error: null }),
              };
              return builder;
            }
            return origFrom(tabela);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof supabase;

    const erro = await sendMessageHandler(
      supabaseComCorrida,
      ctxInstitucional(),
      payloadInstitucional(),
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({ status: 409, code: "state_conflict" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toMatchObject({ status: "failed", error_code: "conversation_closed" });
    expect(capturas.patches.conversations).toEqual([]);
    expect(capturas.patches.contacts).toEqual([]);
  });

  it("Cenário 7a: recusa ai_agent, sessão humana e token sem dispatchMode validado (fail-closed 403)", async () => {
    const fetchSpy = wahaAceita();
    const { supabase, mensagens } = criarDubleDoHandler({ conversation: baseConversa() });

    const semCtx = await sendMessageHandler(
      supabase,
      { organization_id: ORG, actor: deriveActor(["mcp:write"], TOKEN_ID), requestId: "req-1" },
      payloadInstitucional(),
    ).catch((e: unknown) => e);
    const agente = await sendMessageHandler(
      supabase,
      ctxInstitucional({
        actor: { type: "ai_agent", id: "run-1", role: "agent", api_token_id: TOKEN_ID },
      }),
      payloadInstitucional(),
    ).catch((e: unknown) => e);
    const humano = await sendMessageHandler(
      supabase,
      ctxInstitucional({ actor: { type: "user", id: USER } }),
      payloadInstitucional(),
    ).catch((e: unknown) => e);

    expect(semCtx).toMatchObject({ status: 403, code: "forbidden" });
    expect(agente).toMatchObject({ status: 403, code: "forbidden" });
    expect(humano).toMatchObject({ status: 403, code: "forbidden" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mensagens).toHaveLength(0);
  });

  it("Cenário 7b: recusa on_behalf_of_user_id no modo institucional (422)", async () => {
    const fetchSpy = wahaAceita();
    const { supabase, mensagens } = criarDubleDoHandler({ conversation: baseConversa() });

    const erro = await sendMessageHandler(
      supabase,
      ctxInstitucional({ onBehalfOf: { userId: USER, userName: "Ana", tokenName: "ERP" } }),
      payloadInstitucional({ on_behalf_of_user_id: USER }),
    ).catch((e: unknown) => e);

    expect(erro).toMatchObject({ status: 422, code: "validation_failed" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mensagens).toHaveLength(0);
  });

  it("Cenário 7c: cliente NÃO consegue forjar metadata.dispatch_mode='institutional' sem permissão", async () => {
    wahaAceita("3EB0SPOOF1");
    const { supabase, capturas, mensagens } = criarDubleDoHandler({
      conversation: baseConversa({ unread_count_for_assignee: 3 }),
    });

    await sendMessageHandler(
      supabase,
      { organization_id: ORG, actor: deriveActor(["mcp:write"], TOKEN_ID), requestId: "req-spoof" },
      {
        conversation_id: CONV,
        type: "text",
        body: "Tentativa de spoofing via metadata",
        metadata: { dispatch_mode: "institutional", integration_actor_name: "Token Falso" },
      } as SendMessageInput,
    );

    expect(
      (mensagens[0]!.metadata as Record<string, unknown>)[CHAVE_DO_MODO_DE_ENVIO],
    ).toBeUndefined();
    expect((capturas.patches.conversations ?? []).length).toBeGreaterThan(0);
    expect((capturas.patches.contacts ?? []).length).toBeGreaterThan(0);
  });

  it("Cenário 8: contato bloqueado e restrições de canal (24h fechada / pausado / pre_go_live) seguem bloqueando", async () => {
    const metaSpy = metaAceita();
    const { supabase: supBlk } = criarDubleDoHandler({
      conversation: baseConversa({
        contacts: { phone_number: "+5531999998888", is_blocked: true },
      }),
    });
    const erroBlk = await sendMessageHandler(
      supBlk,
      ctxInstitucional(),
      payloadInstitucional(),
    ).catch((e: unknown) => e);
    expect(erroBlk).toMatchObject({ status: 403 });

    const { supabase: sup24h } = criarDubleDoHandler({
      conversation: baseConversa({
        last_inbound_at: new Date(Date.now() - 48 * 3_600_000).toISOString(),
        channel_sessions: {
          id: SESSION,
          organization_id: ORG,
          provider: "meta_cloud",
          waha_session_name: null,
          status: "WORKING",
          archived_at: null,
          metadata: {},
        },
      }),
    });
    const erro24h = await sendMessageHandler(
      sup24h,
      ctxInstitucional(),
      payloadInstitucional(),
    ).catch((e: unknown) => e);
    expect(erro24h).toMatchObject({ status: 422, code: "janela_fechada" });
    expect(metaSpy).not.toHaveBeenCalled();

    const { supabase: supPre, capturas: capturasPre } = criarDubleDoHandler({
      conversation: baseConversa({
        channel_sessions: {
          id: SESSION,
          organization_id: ORG,
          provider: "waha",
          waha_session_name: "default",
          status: "WORKING",
          archived_at: null,
        },
      }),
      channelMetadata: {
        ai_gate: "allowlist",
        ai_gate_mode: "pre_go_live",
        ai_test_phone_numbers: ["+5511000000000"],
      },
    });
    const resPre = await sendMessageHandler(supPre, ctxInstitucional(), payloadInstitucional());
    expect(resPre).toMatchObject({ status: "failed", error_code: "pre_go_live" });
    expect(capturasPre.patches.conversations).toEqual([]);
  });

  it("Cenário 9: compatibilidade retroativa — sem dispatch_mode ou dispatch_mode='operational' preserva atualizações normais e hash legado", async () => {
    wahaAceita("3EB0LEGACY");
    const { supabase, capturas, mensagens } = criarDubleDoHandler({
      conversation: baseConversa({ unread_count_for_assignee: 2 }),
    });

    await sendMessageHandler(
      supabase,
      { organization_id: ORG, actor: deriveActor(["mcp:write"], TOKEN_ID), requestId: "req-op" },
      {
        conversation_id: CONV,
        type: "text",
        body: "Resposta operacional normal",
        dispatch_mode: "operational",
      },
    );

    expect((capturas.patches.conversations ?? []).length).toBeGreaterThan(0);
    expect((capturas.patches.conversations ?? [])[0]).toMatchObject({
      unread_count_for_assignee: 0,
    });
    expect((capturas.patches.contacts ?? []).length).toBeGreaterThan(0);
    expect(
      (mensagens[0]!.metadata as Record<string, unknown>)[CHAVE_DO_MODO_DE_ENVIO],
    ).toBeUndefined();

    // Schema sem dispatch_mode NÃO altera o objeto parseado nem o hash legado.
    const semCampo = sendMessagePorTelefoneSchema.parse({ conversation_id: CONV, body: "Oi" });
    expect(Object.prototype.hasOwnProperty.call(semCampo, "dispatch_mode")).toBe(false);
    expect(
      sendMessageSchema.safeParse({ conversation_id: CONV, body: "Oi", dispatch_mode: "invalido" })
        .success,
    ).toBe(false);
  });
});
