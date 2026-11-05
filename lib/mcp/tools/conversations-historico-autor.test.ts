/**
 * #4077 — O HISTÓRICO PELO MCP DIZ QUEM DA EQUIPE ENVIOU (e a transcrição do áudio).
 *
 * ═══ O que este arquivo prende ═══
 *
 *   1. Cada mensagem devolvida por `crm_get_conversation_history` traz
 *      `sent_by_user_id` (a coluna que o handler já lia e a projeção jogava fora)
 *      e `sent_by_user_name`, quando o nome é resolvível.
 *   2. Mensagem RECEBIDA do cliente não tem autor interno: id e nome vazios —
 *      nunca o id de um "sistema".
 *   3. O nome custa UMA consulta de vínculo por página e UM lookup por AUTOR
 *      DISTINTO (nunca por mensagem). 4 mensagens de 2 pessoas = 1 + 2.
 *   4. Quem não é (ou não foi) membro da organização do chamador sai sem nome —
 *      a linha de outra organização não vira nome na resposta.
 *   5. A transcrição continua atrás do escopo próprio (`messages:derived:read`,
 *      #3996): aqui ela vem com o escopo, o estado `pending` não inventa texto, e
 *      mensagem de texto não ganha campo derivado nenhum sem o escopo.
 *   6. O resto do contrato não mudou: limite e cursor passam iguais, `cursor` e
 *      `has_more` voltam, e o chamador sem `mcp:read` continua recusado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const createSignedUrl = vi.fn();
const membrosDaOrg = vi.fn();
const getUserById = vi.fn();

/**
 * Dublê do admin client: `user_organizations` (a conferência de vínculo) e o
 * GoTrue Admin API (onde o nome mora). Os contadores são o critério de "sem N+1".
 */
const consultas = { vinculo: 0, nomes: 0, storage: 0 };
let membros: Record<string, string[]> = {};
const NOMES: Record<string, string> = {};

function adminFalso() {
  return {
    from: (tabela: string) => {
      if (tabela !== "user_organizations") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        select: () => ({
          eq: (_coluna: string, orgId: string) => ({
            in: async (_c: string, ids: string[]) => {
              consultas.vinculo += 1;
              membrosDaOrg(orgId, ids);
              return {
                data: ids
                  .filter((id) => (membros[orgId] ?? []).includes(id))
                  .map((user_id) => ({ user_id })),
                error: null,
              };
            },
          }),
        }),
      };
    },
    auth: {
      admin: {
        getUserById: async (id: string) => {
          consultas.nomes += 1;
          getUserById(id);
          if (!NOMES[id]) return { data: { user: null }, error: { message: "sem nome" } };
          return { data: { user: { user_metadata: { full_name: NOMES[id] } } }, error: null };
        },
      },
    },
    storage: {
      from: () => ({
        createSignedUrl: async () => {
          consultas.storage += 1;
          return { data: { signedUrl: "https://s/assinado" }, error: null };
        },
      }),
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminFalso() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ listMessagesHandler: vi.fn() }));
vi.mock("@/app/api/v1/conversations/_handler", () => ({
  getConversationHandler: vi.fn(),
  listConversationsHandler: vi.fn(),
}));
vi.mock("@/lib/audit", async () => {
  const real = await vi.importActual<Record<string, unknown>>("@/lib/audit");
  return { ...real, isServiceRoleConfigured: () => true };
});

import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import { ensureScope, McpAuthError } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";

import { crmGetConversationHistory } from "./conversations";

const mockedList = vi.mocked(listMessagesHandler);
const CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
const ORG = "org-do-chamador";

const ctx = {
  organizationId: ORG,
  role: "agent",
  actor: { type: "api_token", id: "tok" },
  apiTokenId: "tok",
  tokenScopes: ["mcp:read"],
  requestId: "req",
  supabase: adminFalso(),
} as unknown as McpContext;

const msg = (o: Record<string, unknown>) => ({
  id: "m",
  direction: "inbound",
  type: "text",
  body: null,
  media_url: null,
  media_mime: null,
  media_size_bytes: null,
  media_storage_path: null,
  media_derived_text: null,
  media_derived_status: null,
  sent_via: "user",
  sent_by_user_id: null,
  sent_at: "2026-11-05T12:00:00Z",
  status: "delivered",
  ...o,
});

async function historico(context: McpContext, mensagens: Record<string, unknown>[], q = {}) {
  mockedList.mockResolvedValue({
    messages: mensagens,
    cursor: null,
    has_more: false,
  } as never);
  return (await crmGetConversationHistory.handler(
    { conversation_id: CONVERSATION_ID, limit: 20, ...q } as never,
    context,
  )) as { messages: Array<Record<string, unknown>>; cursor: unknown; has_more: boolean };
}

beforeEach(() => {
  consultas.vinculo = 0;
  consultas.nomes = 0;
  consultas.storage = 0;
  membrosDaOrg.mockClear();
  getUserById.mockClear();
  createSignedUrl.mockClear();
  mockedList.mockReset();
  membros = { [ORG]: ["u-andreia", "u-thamyres"] };
  for (const k of Object.keys(NOMES)) delete NOMES[k];
  NOMES["u-andreia"] = "Andreia Cristina de Souza";
  NOMES["u-thamyres"] = "Thamyres";
});

describe("#4077 — autor da mensagem no histórico MCP", () => {
  it("mensagem de pessoa da equipe sai com o id e o nome; a do cliente sai sem autor", async () => {
    const out = await historico(ctx, [
      msg({ id: "in", direction: "inbound", body: "bom dia" }),
      msg({ id: "out", direction: "outbound", sent_via: "user", sent_by_user_id: "u-andreia" }),
    ]);

    expect(out.messages[1]).toMatchObject({
      id: "out",
      sent_by_user_id: "u-andreia",
      sent_by_user_name: "Andreia Cristina de Souza",
    });
    expect(out.messages[0]).toMatchObject({
      id: "in",
      sent_by_user_id: null,
      sent_by_user_name: null,
    });
  });

  it("áudio transcrito vem com o texto; áudio ainda sem transcrição diz o estado e não inventa", async () => {
    const out = await historico(
      { ...ctx, tokenScopes: ["mcp:read", "messages:derived:read"] } as McpContext,
      [
        msg({
          id: "pronto",
          type: "audio",
          direction: "inbound",
          media_url: "https://gateway/a",
          media_storage_path: "p/a.ogg",
          media_derived_status: "ready",
          media_derived_text: "quero fechar os 300",
        }),
        msg({
          id: "pendente",
          type: "audio",
          direction: "inbound",
          media_url: "https://gateway/b",
          media_storage_path: "p/b.ogg",
          media_derived_status: "pending",
        }),
      ],
    );

    expect(out.messages[0]).toMatchObject({
      media_derived_status: "ready",
      media_derived_text: "quero fechar os 300",
    });
    expect(out.messages[1]).toMatchObject({
      media_derived_status: "pending",
      media_derived_text: null,
    });
  });

  it("mensagem sem mídia não ganha campo derivado sem o escopo próprio", async () => {
    const out = await historico(ctx, [msg({ id: "texto", body: "oi" })]);

    expect(out.messages[0]).not.toHaveProperty("media_derived_text");
    expect(out.messages[0]).not.toHaveProperty("media_derived_status");
    expect(out.messages[0]).toMatchObject({ media_status: "none" });
  });

  it("UMA consulta de vínculo por página e UM lookup por AUTOR DISTINTO — nunca por mensagem", async () => {
    await historico(ctx, [
      msg({ id: "m1", direction: "outbound", sent_by_user_id: "u-andreia" }),
      msg({ id: "m2", direction: "outbound", sent_by_user_id: "u-andreia" }),
      msg({ id: "m3", direction: "outbound", sent_by_user_id: "u-thamyres" }),
      msg({ id: "m4", direction: "outbound", sent_by_user_id: "u-andreia" }),
    ]);

    expect(consultas.vinculo).toBe(1);
    expect(consultas.nomes).toBe(2);
    expect(membrosDaOrg).toHaveBeenCalledWith(ORG, ["u-andreia", "u-thamyres"]);
  });

  it("IA, automação, sistema e celular não pagam lookup e saem com nome vazio", async () => {
    const out = await historico(ctx, [
      msg({ id: "ia", direction: "outbound", sent_via: "ai", sent_by_user_id: null }),
      msg({ id: "auto", direction: "outbound", sent_via: "automation", sent_by_user_id: null }),
      msg({ id: "sis", direction: "outbound", sent_via: "system", sent_by_user_id: null }),
      msg({ id: "cel", direction: "outbound", sent_via: "external_device", sent_by_user_id: null }),
    ]);

    expect(consultas.vinculo).toBe(0);
    expect(consultas.nomes).toBe(0);
    expect(out.messages.map((m) => m.sent_by_user_name)).toEqual([null, null, null, null]);
  });

  it("autor de OUTRA organização sai sem nome: o id não vira nome na resposta", async () => {
    const out = await historico(ctx, [
      msg({ id: "de-fora", direction: "outbound", sent_by_user_id: "u-de-fora" }),
    ]);

    expect(out.messages[0]).toMatchObject({
      sent_by_user_id: "u-de-fora",
      sent_by_user_name: null,
    });
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("nome não resolvido não derruba o histórico: sai vazio e o id continua sendo a verdade", async () => {
    delete NOMES["u-thamyres"];
    const out = await historico(ctx, [
      msg({ id: "m1", direction: "outbound", sent_by_user_id: "u-thamyres" }),
    ]);

    expect(out.messages[0]).toMatchObject({
      sent_by_user_id: "u-thamyres",
      sent_by_user_name: null,
    });
  });

  it("limite, cursor, `cursor` e `has_more` passam iguais ao de antes", async () => {
    mockedList.mockResolvedValue({
      messages: [msg({ id: "m1", body: "oi" })],
      cursor: "proximo",
      has_more: true,
    } as never);
    const out = (await crmGetConversationHistory.handler(
      { conversation_id: CONVERSATION_ID, limit: 5, cursor: "atual" } as never,
      ctx,
    )) as { messages: unknown[]; cursor: unknown; has_more: boolean };

    expect(mockedList).toHaveBeenCalledWith(expect.anything(), expect.anything(), CONVERSATION_ID, {
      limit: 5,
      cursor: "atual",
    });
    expect(out).toMatchObject({ cursor: "proximo", has_more: true });
    expect(out.messages).toHaveLength(1);
  });

  it("chamador sem `mcp:read` continua recusado", () => {
    expect(crmGetConversationHistory.requiresScope).toBe("mcp:read");
    expect(() => ensureScope([], "mcp:read")).toThrow(McpAuthError);
  });
});
