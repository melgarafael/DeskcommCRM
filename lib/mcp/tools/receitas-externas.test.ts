import { describe, expect, it } from "vitest";

import { crmConsultarReceita } from "./receitas-externas";
import type { McpContext } from "@/lib/mcp/types";

const SENTINELA_ORG = "org-sentinela-isolamento";

function ctxFake(organizationId: string): McpContext & { __eqChamadas: Array<string[]> } {
  const eqChamadas: Array<string[]> = [];
  const chain = {
    select: () => chain,
    eq: (coluna: string, valor: unknown) => {
      eqChamadas.push([coluna, String(valor)]);
      return chain;
    },
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return {
    organizationId,
    role: "agent",
    actor: { type: "ai_agent", id: "agent-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: { from: () => chain },
    __eqChamadas: eqChamadas,
  } as unknown as McpContext & { __eqChamadas: Array<string[]> };
}

describe("crm_consultar_receita — isolamento por organização", () => {
  it("usa o organization_id do ctx na query (nunca do argumento)", async () => {
    const ctx = ctxFake(SENTINELA_ORG);
    await crmConsultarReceita.handler(
      { acao: "listar", connection_id: "conn-1" },
      ctx,
    );
    const orgChamada = ctx.__eqChamadas.find(([c]) => c === "organization_id");
    expect(orgChamada, "a query deve filtrar por organization_id").toBeDefined();
    expect(orgChamada![1]).toBe(SENTINELA_ORG);
  });
});
