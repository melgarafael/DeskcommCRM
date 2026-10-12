import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { validarEscopoDaVersao } from "@/lib/ai/agents/escopo";
import type { AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
}));
// O stub do admin responde a uma cadeia só; a conferência de escopo fala com
// outras duas tabelas. O que este arquivo prova é o PATCH — quem prova a
// conferência é `tests/unit/versao-do-agente-referencias-da-org.test.ts`.
vi.mock("@/lib/ai/agents/escopo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/agents/escopo")>()),
  validarEscopoDaVersao: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// #2052: a rota deixou de chamar `requireRole` direto e passou pelo
// `resolveAuthDual` (sessão OU Bearer). O helper chama `createClient()` do
// servidor no ramo de sessão, que precisa do escopo de request do Next — coisa
// que este teste isolado não tem. O que este arquivo prova é o PATCH, não o
// auth: quem prova o caminho aceito/recusado é
// `tests/unit/configuracao-do-agente-por-token-aceita-e-recusa.test.ts`.
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(async () => ({
    ok: true,
    organizationId: "22222222-2222-4222-8222-222222222222",
    actor: { type: "user", id: "11111111-1111-4111-8111-111111111111" },
    supabase: {},
    idioma: "pt-BR",
    via: "session",
  })),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const FLOW = "55555555-5555-4555-8555-555555555555";
const FUNIL = "66666666-6666-4666-8666-666666666666";
const MATERIAL = "77777777-7777-4777-8777-777777777777";

const followupExistente = {
  enabled: true,
  flow_pointer_ids: [FLOW],
  send_window: null,
  callback_enabled: true,
};

function adminStub(
  atualizacoes: Record<string, unknown>[],
  followup: Record<string, unknown> = followupExistente,
) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: VERSION,
                  status: "draft",
                  agent_id: AGENT,
                  organization_id: ORG,
                  followup,
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        atualizacoes.push(payload);
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: { id: VERSION, ...payload }, error: null }),
              }),
            }),
          }),
        };
      },
    }),
  };
}

describe("PATCH .../versions/:vid — atualização parcial", () => {
  const atualizacoes: Record<string, unknown>[] = [];

  beforeEach(() => {
    atualizacoes.length = 0;
    vi.mocked(requireSupportWrite).mockResolvedValue(null);

    const user: AuthUser = {
      id: USER,
      email: "admin@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR",
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
    };
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user,
      org: { orgId: ORG, name: "Org", role: "admin" },
    });
    vi.mocked(createAdminClient).mockReturnValue(adminStub(atualizacoes) as never);
    vi.mocked(validarEscopoDaVersao).mockResolvedValue({ ok: true } as never);
  });

  // O funil e o material entravam só no schema, não no objeto de escrita: a
  // resposta era 200 e a versão seguia com a lista antiga. Integrações por
  // token chegam aqui; a tela usa `saveAgentDraftAction`, que já gravava.
  it("grava o escopo de funil e de material, e os submete à conferência", async () => {
    const { PATCH } = await import("./route");
    const request = new NextRequest("http://localhost/api/v1/ai/agents/x/versions/y", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pipeline_ids: [FUNIL], knowledge_source_ids: [MATERIAL] }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(validarEscopoDaVersao).mock.calls.at(-1)?.[2]).toMatchObject({
      pipeline_ids: [FUNIL],
      knowledge_source_ids: [MATERIAL],
    });
    expect(atualizacoes).toEqual([
      { pipeline_ids: [FUNIL], knowledge_source_ids: [MATERIAL] },
    ]);
  });

  it("esvazia o escopo quando a lista vem vazia", async () => {
    const { PATCH } = await import("./route");
    const request = new NextRequest("http://localhost/api/v1/ai/agents/x/versions/y", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ knowledge_source_ids: [] }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });

    expect(response.status).toBe(200);
    expect(atualizacoes).toEqual([{ knowledge_source_ids: [] }]);
  });

  it("muda somente a janela e preserva o restante da configuração", async () => {
    const sendWindow = {
      start: "09:00",
      end: "18:00",
      weekdays: [1, 2, 3, 4, 5],
    };
    const { PATCH } = await import("./route");
    const request = new NextRequest("http://localhost/api/v1/ai/agents/x/versions/y", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ followup: { send_window: sendWindow } }),
    });

    const response = await PATCH(request, {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });

    expect(response.status).toBe(200);
    expect(atualizacoes).toEqual([
      {
        followup: {
          enabled: true,
          flow_pointer_ids: [FLOW],
          send_window: sendWindow,
          callback_enabled: true,
        },
      },
    ]);
  });

  it("altera callback_enabled isoladamente e preserva followup normal e a janela", async () => {
    const sendWindow = { start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] };
    const { PATCH } = await import("./route");
    const request = new NextRequest("http://localhost/api/v1/ai/agents/x/versions/y", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ followup: { callback_enabled: false } }),
    });

    // Este caso comprova também que o estado existente é o mesmo JSON que o PATCH parcial mescla.
    vi.mocked(createAdminClient).mockReturnValue(
      adminStub(atualizacoes, { ...followupExistente, send_window: sendWindow }) as never,
    );
    const response = await PATCH(request, {
      params: Promise.resolve({ id: AGENT, vid: VERSION }),
    });

    expect(response.status).toBe(200);
    expect(atualizacoes).toEqual([
      {
        followup: {
          enabled: true,
          flow_pointer_ids: [FLOW],
          send_window: sendWindow,
          callback_enabled: false,
        },
      },
    ]);
  });
});
