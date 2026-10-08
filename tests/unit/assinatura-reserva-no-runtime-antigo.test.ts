import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A RESERVA DA ASSINATURA NO RUNTIME ANTIGO (`runAgent`) — chave e provider
 * andam juntos (#1672, triagem).
 *
 * Sem login utilizável, `runAgent` pega a chave `openai` da empresa como
 * reserva. A versão continua dizendo `openai-assinatura`, e montar o modelo
 * com ESSE provider mandaria a chave de API ao endpoint do Codex
 * (`api.openai.com/v1`), que não a aceita: a reserva existiria e
 * nunca responderia. O motor (`resolveOrgLlmConfig`) já devolvia o provider da
 * reserva junto da chave; este arquivo amarra o mesmo par no `runAgent`.
 *
 * O dublê de `createOpenAI` guarda com que endereço o modelo foi montado e
 * para o turno ali — nada sai para a rede.
 */

const montagens: Array<{ apiKey?: string; baseURL?: string }> = [];
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: (opcoes: { apiKey?: string; baseURL?: string }) => {
    montagens.push({ apiKey: opcoes.apiKey, baseURL: opcoes.baseURL });
    return () => {
      throw new Error("parou_no_modelo");
    };
  },
}));

const lerLogin = vi.fn(async (): Promise<unknown> => null);
vi.mock("@/lib/ai/credenciais/login-codex", () => ({
  lerLoginCodexRenovandoSeProxima: lerLogin,
}));

vi.mock("@/lib/ai/runtime/tools", () => ({ pickToolsFromMcp: vi.fn(() => ({})) }));
vi.mock("@/lib/ai/runtime/mcp_token", () => ({
  mintEphemeralToken: vi.fn(async () => ({ id: "tok-1" })),
  revokeEphemeralToken: vi.fn(async () => {}),
}));
vi.mock("@/lib/instalacao/modulos", () => ({ modulosLigados: vi.fn(async () => []) }));
vi.mock("@/lib/organizacao/capacidades", () => ({ capacidadesDaOrganizacao: vi.fn(async () => []) }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  currentExecutionJob: () => undefined,
  currentExecutionBoundary: () => undefined,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/credentials", () => ({
  CredentialUnavailableError: class extends Error {},
  loadCredential: vi.fn(async () => ({ apiKey: "sk-reserva-da-empresa", baseUrl: null })),
}));
vi.mock("@/lib/ai/runtime/finalize", () => ({ finalizeRun: vi.fn(async () => {}), sendFinalResponse: vi.fn() }));

let linhas: Record<string, unknown> = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: () => chain,
        eq: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => ok({ error: null }),
      };
      return chain;
    },
    rpc: async () => ({ error: null }),
  }),
}));

beforeAll(async () => {
  await import("@/lib/ai/runtime/agent");
}, 120_000);

beforeEach(() => {
  montagens.length = 0;
  lerLogin.mockReset();
  lerLogin.mockImplementation(async () => null);
  linhas = {
    ai_agent_runs: {
      id: "run-1",
      organization_id: "org-1",
      agent_id: "agente-1",
      agent_version_id: "versao-1",
      channel_session_id: null,
      inbound_message_id: null,
      status: "pending",
      is_dry_run: true,
      contact_id: "11111111-1111-4111-8111-111111111111",
      conversation_id: "conv-1",
    },
    ai_agent_versions: {
      id: "versao-1",
      organization_id: "org-1",
      agent_id: "agente-1",
      system_prompt: "x",
      provider: "openai-assinatura",
      model: "gpt-5",
      credential_id: null,
      tool_ids: [],
      handoff_keywords: [],
      handoff_tool_enabled: false,
    },
    ai_agents: { id: "agente-1", organization_id: "org-1", created_by: null },
    // A chave `openai` da empresa — a reserva.
    ai_provider_credentials: { id: "cred-openai" },
  };
});

async function rodar() {
  const { runAgent } = await import("@/lib/ai/runtime/agent");
  await runAgent({ runId: "run-1", override: { sampleMessage: "oi" } });
}

describe("runAgent: a reserva da assinatura fala pelo provider da reserva", () => {
  it("sem login utilizável, a chave openai da empresa vai ao endpoint da OpenAI, não ao do Codex", async () => {
    await rodar();
    expect(montagens).toHaveLength(1);
    expect(montagens[0]!.apiKey).toBe("sk-reserva-da-empresa");
    expect(montagens[0]!.baseURL, "chave de API mandada ao endpoint do Codex").toBeUndefined();
  });

  it("controle: com login utilizável, o access_token vai ao endpoint do Codex", async () => {
    lerLogin.mockImplementation(async () => ({ access_token: "at-da-assinatura", refresh_token: "rt", expires_at: null }));
    await rodar();
    expect(montagens).toHaveLength(1);
    expect(montagens[0]!.apiKey).toBe("at-da-assinatura");
    expect(montagens[0]!.baseURL).toContain("api.openai.com/v1");
  });
});
