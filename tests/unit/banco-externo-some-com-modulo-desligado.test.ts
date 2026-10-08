import { describe, expect, it, vi } from "vitest";

/**
 * O módulo `banco_externo` desligado tira as duas ferramentas do que o turno
 * ENTREGA ao modelo — com as ferramentas REAIS do catálogo, não com dublê.
 *
 * Antes do conserto as duas entradas de `catalogo/dados-externos.ts` não
 * declaravam `modulo`, então `deModuloDesligado` nunca as escondia: com o
 * módulo desligado elas seguiam oferecidas ao agente e ao MCP externo e
 * respondiam "não foi possível abrir a conexão" (e `sem_conexao` mandava
 * cadastrar numa tela que dá 404). O padrão é o de honorários.
 */
vi.mock("@/lib/audit", () => ({
  audit: vi.fn().mockResolvedValue(undefined),
  isServiceRoleConfigured: () => false,
}));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));

const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { TOOL_CATALOG, deModuloDesligado } = await import("@/lib/mcp/tools/catalogo");

const ORG = "11111111-1111-4111-8111-111111111111";
const NOMES = ["crm_describe_external_data", "crm_query_external_data"] as const;

function montar(modulosLigados: Array<"banco_externo">) {
  const ator = { type: "ai_agent", id: "ag-1", role: "ai_operator" };
  const supabase = {} as never;
  return pickToolsFromMcp({
    toolIds: [...NOMES],
    auth: {
      organizationId: ORG,
      role: "ai_operator",
      scopes: ["mcp:read"],
      actor: ator,
      apiTokenId: "tok-1",
    },
    ctx: {
      organizationId: ORG,
      role: "ai_operator",
      actor: ator,
      apiTokenId: "tok-1",
      requestId: "req-1",
      supabase,
    },
    supabase,
    modulosLigados,
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
  } as never);
}

describe("banco_externo desligado: as ferramentas não chegam ao modelo", () => {
  it("o catálogo declara o módulo nas duas entradas", () => {
    for (const nome of NOMES) {
      const entrada = TOOL_CATALOG.find((t) => t.name === nome);
      expect(entrada, nome).toBeDefined();
      expect(entrada?.modulo, nome).toBe("banco_externo");
    }
  });

  it("deModuloDesligado: desligado esconde, ligado mostra", () => {
    for (const nome of NOMES) {
      expect(deModuloDesligado(nome, []), nome).toBe(true);
      expect(deModuloDesligado(nome, ["banco_externo"]), nome).toBe(false);
    }
  });

  it("pickToolsFromMcp com o módulo desligado entrega zero ferramentas, mesmo marcadas na versão do agente", () => {
    expect(Object.keys(montar([]))).toEqual([]);
  });

  it("controle: com o módulo ligado as duas chegam", () => {
    expect(Object.keys(montar(["banco_externo"])).sort()).toEqual([...NOMES].sort());
  });
});
