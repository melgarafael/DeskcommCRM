/**
 * A MENSAGEM ENVIADA POR TOKEN DIZ QUAL INTEGRAÇÃO FALOU (#5160).
 *
 * ─── O defeito, medido na main `03604fd978` ────────────────────────────────
 *
 * `origemDaMensagem` carimba `sent_via='system'` para `actor.type === "api_token"`
 * e o balão desenhava só "Sistema". A coluna `sent_via` está certa (a integração
 * não é IA nem pessoa — #866) e NÃO muda aqui: o que faltava era o NOME da
 * linha do token (`api_tokens.name`) viajar GRAVADO em `messages.metadata`,
 * porque o balão não faz join.
 *
 * ─── O que este teste prende ───────────────────────────────────────────────
 *
 * (A) envio por token grava `metadata.integration_actor_name` com o nome da
 *     LINHA do token, e a linha continua `sent_via='system'`;
 * (B) `metadata` do CLIENTE não escolhe o nome: o valor forjado no corpo é
 *     descartado e o da linha do token vence;
 * (C) sem nome na linha (token antigo/revogado), a chave NÃO é gravada — nem
 *     com o cliente mandando uma —, e o balão cai para "Integração" (teste de
 *     componente);
 * (D) módulo conectado não ganha nome (decisão declarada na PR): a identidade
 *     dele é o `slug`, não o `name` da linha do token.
 *
 * Dublê COMPARTILHADO (`tests/helpers/duble-do-handler.ts`), como manda a
 * catraca `send-message-handler-nao-ganha-novo-duble`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { deriveActor } from "@/lib/mcp/auth";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const TOKEN_ID = "77777777-7777-4777-8777-777777777777";
const BARE = "3EB0ABCDEF0123456789";

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
    last_inbound_at: "2026-11-23T09:00:00.000Z",
    contacts: { phone_number: "+553****8888", wa_identity: null, wa_lid: null, is_blocked: false },
    channel_sessions: {
      provider: "waha",
      waha_session_name: "default",
      status: "WORKING",
      archived_at: null,
      metadata: {},
    },
  };
}

/** O ator de um Bearer sem escopo de agente — a integração, não a IA (#866). */
const ctxDoToken = (over: Partial<HandlerCtx> = {}): HandlerCtx => ({
  organization_id: ORG,
  actor: deriveActor(["mcp:write"], TOKEN_ID),
  requestId: "req-5160-token",
  ...over,
});

/** O ator do módulo conectado: `id` é o token, a identidade é o `slug`. */
const atorDeModulo: Actor = { type: "module", id: TOKEN_ID, slug: "acme/estoque" };

const input = {
  conversation_id: CONV,
  type: "text",
  body: "Boa tarde! Posição atualizada do estoque.",
} as SendMessageInput;

function wahaRespondendo() {
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "test-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ id: { id: BARE } }), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("mensagem enviada por token de API nomeia a integração (#5160)", () => {
  it("⭐ grava o nome da LINHA do token, e `sent_via` continua 'system'", async () => {
    wahaRespondendo();
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa(),
      tokenName: "ERP Externo",
    });

    await sendMessageHandler(supabase, ctxDoToken(), input);

    const linha = capturas.inserts.messages?.at(-1);
    expect(linha, "o envio por token não chegou ao INSERT").toBeDefined();
    expect(linha?.sent_via, "sent_via intocado: integração segue 'system' (#866)").toBe("system");
    expect(
      (linha?.metadata as Record<string, unknown> | undefined)?.integration_actor_name,
      "o nome do token não foi gravado na linha — a bolha não faz join e leria só 'Integração'",
    ).toBe("ERP Externo");
    // A leitura foi da LINHA do token, filtrada pela organização do Bearer.
    expect(
      capturas.filtros.api_tokens,
      "a consulta do nome não filtrou pelo id/organização do token",
    ).toEqual([
      { coluna: "id", valor: TOKEN_ID },
      { coluna: "organization_id", valor: ORG },
    ]);
  });

  it("metadata do CLIENTE não escolhe o nome: o valor forjado perde para a linha do token", async () => {
    wahaRespondendo();
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa(),
      tokenName: "ERP Externo",
    });

    await sendMessageHandler(supabase, ctxDoToken(), {
      ...input,
      metadata: { integration_actor_name: "Forjado pelo cliente", assunto: "estoque" },
    } as SendMessageInput);

    const metadata = capturas.inserts.messages?.at(-1)?.metadata as
      | Record<string, unknown>
      | undefined;
    expect(
      metadata?.integration_actor_name,
      "o metadata do corpo sobrescreveu o nome da integração — autorização para forjar a assinatura",
    ).toBe("ERP Externo");
    // O resto do metadata do cliente CONTINUA viajando: o corte é só a chave do nome.
    expect(metadata?.assunto, "o metadata legítimo do cliente sumiu junto").toBe("estoque");
  });

  it("sem nome na linha do token, a chave NÃO é gravada nem com o cliente mandando uma", async () => {
    wahaRespondendo();
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversa(), tokenName: null });

    await sendMessageHandler(supabase, ctxDoToken(), {
      ...input,
      metadata: { integration_actor_name: "Forjado pelo cliente" },
    } as SendMessageInput);

    const metadata = capturas.inserts.messages?.at(-1)?.metadata as
      | Record<string, unknown>
      | undefined;
    expect(
      metadata && Object.prototype.hasOwnProperty.call(metadata, "integration_actor_name"),
      "linha sem nome ficou com o nome forjado (ou com chave vazia): o balão diria um nome que ninguém tem",
    ).toBe(false);
  });

  it("módulo conectado NÃO ganha nome: a identidade dele é o `slug`, não a linha do token", async () => {
    wahaRespondendo();
    const { supabase, capturas } = criarDubleDoHandler({
      conversation: conversa(),
      tokenName: "Token do módulo",
    });

    await sendMessageHandler(
      supabase,
      { organization_id: ORG, actor: atorDeModulo, requestId: "req-5160-modulo" },
      input,
    );

    const linha = capturas.inserts.messages?.at(-1);
    expect(linha?.sent_via, "módulo continua 'system'").toBe("system");
    const metadata = linha?.metadata as Record<string, unknown> | undefined;
    expect(
      metadata && Object.prototype.hasOwnProperty.call(metadata, "integration_actor_name"),
      "módulo passou a gravar nome de token: a decisão da PR é que só o token de API nomeia",
    ).toBe(false);
  });
});
