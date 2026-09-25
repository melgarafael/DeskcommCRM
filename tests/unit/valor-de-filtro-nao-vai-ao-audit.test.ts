import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O valor de filtro de uma consulta ao banco externo é dado do cliente (CPF,
 * telefone, nome) e não pode chegar a `api_audit_log`.
 *
 * `crm_query_external_data` declara `redigirParaAuditoria`, mas a declaração só
 * vale se os DOIS ingressos a aplicarem: o turno do agente
 * (`lib/ai/runtime/tools.ts`) e o servidor MCP público (`lib/mcp/server.ts`).
 * O teste da tool sozinha não pega um ingresso que audite `args` crus — este
 * pega, porque roda a tool real pelos dois caminhos e lê o que foi auditado.
 */
const auditSpy = vi.fn();
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: (e: unknown) => auditSpy(e) }));

const CONEXAO = {
  id: "conn-1",
  organizationId: "00000000-0000-4000-8000-000000000001",
  label: "Outro CRM",
  maxRows: 200,
  maxFilters: 20,
  maxResponseBytes: 30_000,
};
vi.mock("@/lib/external-db/acesso", () => ({
  abrirAcesso: async () => ({ ok: true, conexao: CONEXAO, pool: {} }),
}));
vi.mock("@/lib/external-db/introspeccao", () => ({
  listarTabelas: async () => [],
  colunasDaTabela: async () => new Set(["id", "cpf"]),
}));
vi.mock("@/lib/external-db/leitura", async () => {
  const real = (await vi.importActual("@/lib/external-db/leitura")) as Record<string, unknown>;
  return {
    ...real,
    lerTabela: async () => ({ colunas: ["id"], linhas: [{ id: "1" }], limite: 20, offset: 0 }),
  };
});

/** Só a lista de conexões ativas: `.from().select().eq().eq().order()`. */
function supabaseFake() {
  const cadeia = {
    select: () => cadeia,
    eq: () => cadeia,
    order: async () => ({ data: [{ id: "conn-1", label: "Outro CRM" }], error: null }),
  };
  return { from: () => cadeia };
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => supabaseFake() }));

const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { createMcpServer } = await import("@/lib/mcp/server");

const CPF = "123.456.789-00";
const ARGS = {
  schema: "public",
  tabela: "clientes",
  filtros: [{ coluna: "cpf", operador: "eq", valor: CPF }],
};

const auth = {
  organizationId: CONEXAO.organizationId,
  role: "ai_operator",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "tok",
  scopes: ["mcp:read"],
} as never;

function argsAuditados(): unknown {
  expect(auditSpy).toHaveBeenCalledOnce();
  const evento = auditSpy.mock.lastCall![0] as { args: unknown; success: boolean };
  // Controle: a chamada chegou ao handler e deu certo — senão o caso ficaria
  // verde por auditar uma recusa sem args.
  expect(evento.success).toBe(true);
  return evento.args;
}

beforeEach(() => auditSpy.mockClear());

describe("consulta ao banco externo: o valor do filtro não vai ao audit", () => {
  it("pelo turno do agente", async () => {
    const supabase = supabaseFake();
    const montadas = pickToolsFromMcp({
      supabase: supabase as never,
      ctx: {
        organizationId: CONEXAO.organizationId,
        role: "ai_operator",
        actor: { type: "ai_agent", id: "ag-1" },
        apiTokenId: "tok",
        requestId: "req-1",
        supabase,
      } as never,
      auth,
      toolIds: ["crm_query_external_data"],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
    });
    const { execute } = montadas.crm_query_external_data as unknown as {
      execute: (a: unknown) => Promise<unknown>;
    };
    await execute(ARGS);

    const args = argsAuditados();
    expect(JSON.stringify(args)).not.toContain(CPF);
    expect(args).toMatchObject({ tabela: "clientes", filtros: [{ coluna: "cpf", operador: "eq" }] });
  });

  it("pelo servidor MCP público", async () => {
    const server = createMcpServer(auth, "req-1");
    const [cliente, servidor] = InMemoryTransport.createLinkedPair();
    await server.connect(servidor);
    const client = new Client({ name: "teste", version: "0.0.0" });
    await client.connect(cliente);
    await client.callTool({ name: "crm_query_external_data", arguments: ARGS });
    await client.close();

    const args = argsAuditados();
    expect(JSON.stringify(args)).not.toContain(CPF);
    expect(args).toMatchObject({ tabela: "clientes", filtros: [{ coluna: "cpf", operador: "eq" }] });
  });
});
