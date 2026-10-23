/**
 * ASSUMIR A CONVERSA É UMA REGRA SÓ — e o encaminhamento também a cumpre.
 *
 * ─── O que este teste protege ───────────────────────────────────────────────
 *
 * Quando a empresa liga "a conversa fica com quem atendeu"
 * (`settings.routing.conversation_stays_with_attendant`), responder pelo Inbox
 * assume a conversa livre. O encaminhamento é resposta pelo MESMO caminho de
 * envio, e antes deste conserto ele NÃO assumia: quem encaminhava respondia ao
 * cliente e a conversa continuava livre para outro atendente — a mesma resposta
 * tendo dois desfechos diferentes conforme o botão.
 *
 * A regra virou `assumirConversaAposEnvio` (helper único) e aqui se prova as
 * duas metades:
 *
 *   (a) a REGRA: quem assume (sessão + humano + linha que não falhou) e quem
 *       NÃO assume (token, IA, `failed`, regra desligada);
 *   (b) o CHAMADOR do encaminhamento: depois de encaminhar, o claim condicional
 *       foi pedido para a conversa de DESTINO.
 *
 * A sabotagem que (b) pega: tirar a chamada do helper de
 * `lib/inbox/encaminhar-mensagem.ts` deixa (b) VERMELHO — e nada mais.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";

const { enviado } = vi.hoisted(() => ({ enviado: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: enviado,
  listMessagesHandler: vi.fn(),
}));

// A cópia de objeto e a linha do tempo falam com o admin client; o que se mede
// aqui é a REGRA, não o Storage.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ copy: vi.fn() }) } }),
}));
const { auditado } = vi.hoisted(() => ({ auditado: vi.fn(async () => {}) }));
vi.mock("@/lib/audit", () => ({ audit: auditado, isServiceRoleConfigured: () => false }));
const { trocaDeComando } = vi.hoisted(() => ({ trocaDeComando: vi.fn(async () => {}) }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({ registrarTrocaDeComando: trocaDeComando }));

import { assumirConversaAposEnvio } from "@/lib/inbox/assumir-conversa-apos-envio";
import { encaminharMensagem } from "@/lib/inbox/encaminhar-mensagem";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORIGEM_ID = "22222222-2222-4222-8222-222222222222";
const ORIGEM_CONV = "33333333-3333-4333-8333-333333333333";
const DESTINO_CONV = "44444444-4444-4444-8444-444444444444";
const SESSAO = "55555555-5555-4555-8555-555555555555";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const USUARIO = "77777777-7777-4777-8777-777777777777";

/** A regra ligada, como a tela a grava em `organizations.settings`. */
const REGRA_LIGADA = { routing: { conversation_stays_with_attendant: true } };

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USUARIO },
  requestId: "req-1",
  idioma: "pt-BR",
};

function origemDeTexto() {
  return {
    id: ORIGEM_ID,
    organization_id: ORG,
    conversation_id: ORIGEM_CONV,
    type: "text",
    body: "Segue o orçamento combinado.",
    media_url: null,
    media_storage_path: null,
    media_mime: null,
    revoked_at: null,
  };
}

function fakeSupabase(opts: { settings?: unknown; claim?: Array<{ contact_id: string | null }> | null } = {}) {
  const rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const client = {
    from(tabela: string) {
      const cadeia = {
        select: () => cadeia,
        eq: () => cadeia,
        maybeSingle: async () => {
          if (tabela === "messages") return { data: origemDeTexto(), error: null };
          if (tabela === "conversations") {
            return { data: { id: DESTINO_CONV, channel_session_id: SESSAO }, error: null };
          }
          if (tabela === "channel_sessions") return { data: { id: SESSAO, metadata: {} }, error: null };
          if (tabela === "organizations") return { data: { settings: opts.settings ?? {} }, error: null };
          return { data: null, error: null };
        },
      };
      return cadeia;
    },
    rpc: async (nome: string, args: Record<string, unknown>) => {
      rpcs.push({ nome, args });
      return { data: nome === "fn_conversation_assign" ? (opts.claim ?? [{ contact_id: CONTATO }]) : null, error: null };
    },
  };
  return { supabase: client as unknown as SupabaseClient, rpcs };
}

const pedidosDeClaim = (rpcs: Array<{ nome: string; args: Record<string, unknown> }>) =>
  rpcs.filter((r) => r.nome === "fn_conversation_assign");

afterEach(() => {
  vi.clearAllMocks();
});

describe("(a) assumirConversaAposEnvio — quem assume, e quem não assume", () => {
  it("sessão + humano + linha que não falhou: assume, e deixa o rastro do botão Assumir", async () => {
    const { supabase, rpcs } = fakeSupabase({ settings: REGRA_LIGADA });

    await assumirConversaAposEnvio({
      supabase,
      organizationId: ORG,
      actor: { type: "user", id: USUARIO },
      requestId: "req-1",
      via: "session",
      conversationId: DESTINO_CONV,
      status: "queued",
    });

    expect(pedidosDeClaim(rpcs)).toEqual([
      {
        nome: "fn_conversation_assign",
        args: {
          p_organization_id: ORG,
          p_conversation_id: DESTINO_CONV,
          p_to_user_id: USUARIO,
          p_reason: "claim",
          p_enforce_expected: true,
        },
      },
    ]);
    expect(rpcs.some((r) => r.nome === "emit_event")).toBe(true);
    expect(auditado).toHaveBeenCalledTimes(1);
    expect(trocaDeComando).toHaveBeenCalledTimes(1);
    expect(trocaDeComando).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: DESTINO_CONV,
        contactId: CONTATO,
        tipo: "conversation_claimed",
      }),
    );
  });

  it.each([
    ["token de servidor", { via: "token" as const, actor: { type: "user" as const, id: USUARIO }, status: "queued" }],
    [
      "IA",
      {
        via: "session" as const,
        actor: { type: "ai_agent" as const, id: USUARIO, role: "agent" },
        status: "queued",
      },
    ],
    ["linha que falhou", { via: "session" as const, actor: { type: "user" as const, id: USUARIO }, status: "failed" }],
  ])("%s NÃO assume a conversa", async (_nome, cenario) => {
    const { supabase, rpcs } = fakeSupabase({ settings: REGRA_LIGADA });

    await assumirConversaAposEnvio({
      supabase,
      organizationId: ORG,
      actor: cenario.actor,
      requestId: "req-1",
      via: cenario.via,
      conversationId: DESTINO_CONV,
      status: cenario.status,
    });

    expect(pedidosDeClaim(rpcs)).toEqual([]);
    expect(trocaDeComando).not.toHaveBeenCalled();
  });

  it("regra desligada (padrão): não assume nada", async () => {
    const { supabase, rpcs } = fakeSupabase({ settings: {} });

    await assumirConversaAposEnvio({
      supabase,
      organizationId: ORG,
      actor: { type: "user", id: USUARIO },
      requestId: "req-1",
      via: "session",
      conversationId: DESTINO_CONV,
      status: "queued",
    });

    expect(pedidosDeClaim(rpcs)).toEqual([]);
  });

  it("claim que não pegou (outro atendente chegou antes): nada de linha do tempo", async () => {
    const { supabase, rpcs } = fakeSupabase({ settings: REGRA_LIGADA, claim: [] });

    await assumirConversaAposEnvio({
      supabase,
      organizationId: ORG,
      actor: { type: "user", id: USUARIO },
      requestId: "req-1",
      via: "session",
      conversationId: DESTINO_CONV,
      status: "queued",
    });

    expect(pedidosDeClaim(rpcs)).toHaveLength(1);
    expect(trocaDeComando).not.toHaveBeenCalled();
    expect(auditado).not.toHaveBeenCalled();
  });
});

describe("(b) o encaminhamento assume a conversa do DESTINO", () => {
  it("depois de encaminhar, o claim foi pedido para a conversa de destino", async () => {
    enviado.mockImplementation(
      async (_sb: unknown, _ctx: unknown, input: { conversation_id: string }) => ({
        id: "mensagem-nova",
        organization_id: ORG,
        conversation_id: input.conversation_id,
        body: "Segue o orçamento combinado.",
        direction: "outbound",
        type: "text",
        status: "queued",
      }),
    );
    const { supabase, rpcs } = fakeSupabase({ settings: REGRA_LIGADA });

    const mensagem = await encaminharMensagem(supabase, ctx, {
      messageId: ORIGEM_ID,
      conversationIdDestino: DESTINO_CONV,
      via: "session",
    });

    expect(mensagem.conversation_id).toBe(DESTINO_CONV);
    expect(pedidosDeClaim(rpcs).map((r) => r.args.p_conversation_id)).toEqual([DESTINO_CONV]);
    expect(pedidosDeClaim(rpcs)[0]!.args.p_to_user_id).toBe(USUARIO);
  });

  it("regra desligada: o encaminhamento não assume — e não inventa claim", async () => {
    enviado.mockImplementation(
      async (_sb: unknown, _ctx: unknown, input: { conversation_id: string }) => ({
        id: "mensagem-nova",
        organization_id: ORG,
        conversation_id: input.conversation_id,
        body: null,
        direction: "outbound",
        type: "text",
        status: "queued",
      }),
    );
    const { supabase, rpcs } = fakeSupabase({ settings: {} });

    await encaminharMensagem(supabase, ctx, {
      messageId: ORIGEM_ID,
      conversationIdDestino: DESTINO_CONV,
      via: "session",
    });

    expect(pedidosDeClaim(rpcs)).toEqual([]);
  });
});
