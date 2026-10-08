import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O contato do turno (`contatoDoTurno`) tem de chegar às ferramentas nos DOIS
 * montadores do agente: o do motor (`buildMcpTurnTools`) e o do runtime antigo
 * (`runAgent`). É por ele que as leituras do turno ficam no cliente da conversa
 * — a consulta ao banco externo inclusive (`crm_query_external_data` só aplica o
 * filtro da coluna do cliente quando ele está presente). Os testes do handler
 * passam o contexto na mão e ficam verdes mesmo que um montador pare de
 * repassá-lo; este arquivo amarra o repasse.
 *
 * Daqui até o handler o caminho é `pickToolsFromMcp` (`lib/ai/runtime/tools.ts`),
 * vigiado por `leitura-do-turno-escopo*.test.ts`.
 */

const pickToolsFromMcp = vi.fn((_input: Record<string, unknown>): Record<string, unknown> => {
  throw new Error("parou_na_montagem");
});

/**
 * Grava os argumentos da carga do servidor MCP externo (#2147, item 8): a
 * ESCOLHA (b) é que o CONTATO chegue aqui — turno com conversa não carrega
 * servidor remoto nenhum, e repassar o contato é a única forma de isso valer
 * para os DOIS montadores (Conversador e Operador).
 */
const carregarServidorMcpExternoDoTurno = vi.fn(async (..._argumentos: unknown[]) => null);

vi.mock("@/lib/ai/runtime/tools", () => ({ pickToolsFromMcp }));
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
  loadCredential: vi.fn(async () => ({ apiKey: "chave", baseUrl: null })),
}));
/**
 * O montador do motor carrega o servidor MCP externo LÁ DENTRO (o próprio dele
 * é quem lê `organizations.settings`), e este teste passa `{}` como supabase de
 * propósito: sem o mock, `carregarServidorMcpExternoDoTurno` estoura
 * `supabase.from is not a function` antes de qualquer asserção sobre o contato.
 * Devolver `null` mantém o recado da função: sem registro, não há chave nova.
 */
vi.mock("@/lib/mcp/servidor-externo/carregar", () => ({ carregarServidorMcpExternoDoTurno }));
const finalizeRun = vi.fn(async (_args: Record<string, unknown>) => {});
vi.mock("@/lib/ai/runtime/finalize", () => ({ finalizeRun, sendFinalResponse: vi.fn() }));

let linhas: Record<string, unknown> = {};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: linhas[tabela] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => ok({ error: null }),
      };
      return chain;
    },
    rpc: async () => ({ error: null }),
  }),
}));

const CONTATO = "11111111-1111-4111-8111-111111111111";
const DONO_DA_CONVERSA = "22222222-2222-4222-8222-222222222222";

function entregue(): Record<string, unknown> {
  expect(pickToolsFromMcp).toHaveBeenCalledTimes(1);
  return pickToolsFromMcp.mock.calls[0]![0];
}

beforeEach(() => {
  pickToolsFromMcp.mockClear();
  carregarServidorMcpExternoDoTurno.mockClear();
  finalizeRun.mockClear();
});

/** O 4º argumento de `carregarServidorMcpExternoDoTurno` — é ele que carrega o contato. */
function opcoesDaCarga() {
  expect(carregarServidorMcpExternoDoTurno, "o servidor externo nem foi consultado").toHaveBeenCalled();
  return carregarServidorMcpExternoDoTurno.mock.calls.at(-1)![3] as Record<string, unknown> | undefined;
}

/**
 * O 3º argumento: o `tool_ids` do agente. É por ele que a carga decide se abre
 * rede (item 7) — um montador que deixasse de repassá-lo descobriria o servidor
 * de todo agente, com ou sem escolha remota.
 */
function toolIdsDaCarga() {
  expect(carregarServidorMcpExternoDoTurno, "o servidor externo nem foi consultado").toHaveBeenCalled();
  return carregarServidorMcpExternoDoTurno.mock.calls.at(-1)![2];
}

describe("motor: buildMcpTurnTools repassa o contato do turno", () => {
  async function montar(contactId: string | null) {
    pickToolsFromMcp.mockImplementationOnce(() => ({}));
    const { buildMcpTurnTools } = await import("@/lib/agent-engine/edge/crm/mcp-tools");
    await buildMcpTurnTools(
      { supabase: {} as never },
      { organizationId: "org-1", jobId: "job-1", contactId },
      { agentId: "agente-1", toolIds: ["crm_query_external_data"], pipelineIds: [] } as never,
      { warn: vi.fn() } as never,
    );
    return entregue();
  }

  it("turno com cliente: o contato chega como contatoDoTurno", async () => {
    expect((await montar(CONTATO)).contatoDoTurno).toBe(CONTATO);
  });

  it("turno com cliente: o MESMO contato diz à carga do servidor externo que não carregue nada (item 8)", async () => {
    await montar(CONTATO);
    expect(opcoesDaCarga()).toMatchObject({ contatoDoTurno: CONTATO });
  });

  it("ensaio sem cliente: nada é inventado, nem o contato na carga externa", async () => {
    expect(await montar(null)).not.toHaveProperty("contatoDoTurno");
    expect(opcoesDaCarga()).toEqual({});
  });

  it("a carga recebe o tool_ids do agente — é ele que decide se abre rede (item 7)", async () => {
    await montar(null);
    expect(toolIdsDaCarga()).toEqual(["crm_query_external_data"]);
  });
});

describe("runtime antigo: runAgent repassa o contato do turno", () => {
  // A primeira importação de `lib/ai/runtime/agent` transforma um grafo grande;
  // paga-se aqui com prazo próprio (ver `openrouter-base-url-em-todo-caminho`).
  beforeAll(async () => {
    await import("@/lib/ai/runtime/agent");
  }, 120_000);

  async function rodar(run: { contact_id: string | null; conversation_id: string | null }, conversa?: unknown) {
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
        ...run,
      },
      ai_agent_versions: {
        id: "versao-1",
        organization_id: "org-1",
        agent_id: "agente-1",
        system_prompt: "x",
        provider: "anthropic",
        model: "claude",
        credential_id: "cred-1",
        tool_ids: ["crm_query_external_data"],
        handoff_keywords: [],
        handoff_tool_enabled: false,
      },
      ai_agents: { id: "agente-1", organization_id: "org-1", created_by: null },
      ...(conversa !== undefined ? { conversations: conversa } : {}),
    };
    const { runAgent } = await import("@/lib/ai/runtime/agent");
    return runAgent({ runId: "run-1", override: { sampleMessage: "oi" } });
  }

  it("o contato da linha do run chega como contatoDoTurno", async () => {
    await rodar({ contact_id: CONTATO, conversation_id: "conv-1" });
    expect(entregue().contatoDoTurno).toBe(CONTATO);
  });

  it("turno de conversa: a carga do servidor externo recebe o contato e não carrega nada (item 8)", async () => {
    await rodar({ contact_id: CONTATO, conversation_id: "conv-1" });
    expect(opcoesDaCarga()).toMatchObject({ contatoDoTurno: CONTATO });
  });

  it("linha sem contato: vale o dono da conversa", async () => {
    await rodar({ contact_id: null, conversation_id: "conv-1" }, { contact_id: DONO_DA_CONVERSA });
    expect(entregue().contatoDoTurno).toBe(DONO_DA_CONVERSA);
  });

  it("conversa sem contato nenhum: o turno não roda e nenhuma ferramenta é montada", async () => {
    const r = await rodar({ contact_id: null, conversation_id: "conv-1" }, { contact_id: null });
    expect(r.status).toBe("failed");
    expect(r.error_code).toBe("turn_without_contact");
    expect(pickToolsFromMcp).not.toHaveBeenCalled();
  });

  it("controle: ensaio sem conversa monta sem contatoDoTurno", async () => {
    await rodar({ contact_id: null, conversation_id: null });
    expect(entregue()).not.toHaveProperty("contatoDoTurno");
    expect(opcoesDaCarga()).toEqual({});
  });

  it("a carga recebe o tool_ids da versão — é ele que decide se abre rede (item 7)", async () => {
    await rodar({ contact_id: null, conversation_id: null });
    expect(toolIdsDaCarga()).toEqual(["crm_query_external_data"]);
  });
});
