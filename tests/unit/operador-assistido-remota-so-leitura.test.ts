// @vitest-environment node
/**
 * A mão do Operador no modo ASSISTIDO só leva a remota que MONTOU como leitura.
 *
 * `saiSemAprovacao` (entrega-de-capacidade.ts) olha a marca no id, que é escolha
 * de configuração. Montar como leitura exige as duas metades (marca `leitura` E
 * `readOnlyHint` do servidor). Com `remotasSoLeitura`, o montador deixa de fora
 * toda remota que saiu `write`, mesmo marcada `leitura` no id. Sem a opção, nada
 * muda.
 *
 *     pnpm vitest run tests/unit/operador-assistido-remota-so-leitura.test.ts
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { FerramentaRemota } from "@/lib/mcp/servidor-externo/chamada";
import { toolIdRemoto } from "@/lib/mcp/servidor-externo/ids";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";

/** As duas marcadas `leitura`; só a primeira o servidor declarou somente-leitura. */
const FERRAMENTAS: FerramentaRemota[] = [
  { name: "buscar_pedido", somenteLeitura: true },
  { name: "atualizar_pedido" },
];
const TOOL_IDS = FERRAMENTAS.map((f) => toolIdRemoto(f.name, "leitura"));

const auth = {
  organizationId: ORG,
  role: "ai_operator",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  scopes: ["mcp:read", "mcp:write"],
} as unknown as McpAuthResult;

function montar(remotasSoLeitura?: boolean) {
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: () => cadeia,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
  };
  const supabase = { from: () => cadeia } as never;
  return Object.keys(
    pickToolsFromMcp({
      supabase,
      ctx: { organizationId: ORG, role: auth.role, actor: auth.actor, apiTokenId: auth.apiTokenId, requestId: "r-1", supabase } as unknown as McpContext,
      auth,
      toolIds: TOOL_IDS,
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
      servidorMcpExterno: { servidor: { endpoint: "https://erp.loja/mcp", chave: "segredo" }, ferramentas: FERRAMENTAS },
      ...(remotasSoLeitura === undefined ? {} : { remotasSoLeitura }),
    }),
  );
}

describe("remota na mão do Operador no assistido", () => {
  it("com remotasSoLeitura, a marcada `leitura` que o servidor não declarou leitura fica de fora", () => {
    const nomes = montar(true);
    expect(nomes).toContain("buscar_pedido");
    expect(nomes).not.toContain("atualizar_pedido");
  });

  it("sem a opção (automático, Conversador), as duas montam como antes", () => {
    const nomes = montar();
    expect(nomes).toContain("buscar_pedido");
    expect(nomes).toContain("atualizar_pedido");
  });
});
