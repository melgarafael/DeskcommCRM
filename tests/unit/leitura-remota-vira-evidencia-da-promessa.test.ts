// @vitest-environment node
/**
 * #2147 — quais ferramentas do servidor MCP externo o turno trata como LEITURA
 * para a conferência de promessa.
 *
 * O defeito medido numa instalação em 27/10/2026: o agente consultou a agenda
 * do cliente, recebeu "exame em 30/11/2026 às 17:50" e a conferência de
 * promessa vetou a resposta quatro vezes, porque a data não vinha de nenhuma
 * evidência que ela conhecesse.
 *
 * Quem decide se uma remota é leitura é `definirFerramentasRemotas` (as duas
 * metades: marca do admin e `readOnlyHint` do servidor). A ponte só anota, no
 * coletor `leiturasRemotas`, a remota que ela MONTOU com `category: "read"`.
 * O registro do resultado e o que a conferência faz com ele estão em
 * `evidencias-comerciais.test.ts` e `semantic-request.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { FerramentaRemota } from "@/lib/mcp/servidor-externo/chamada";
import { toolIdRemoto } from "@/lib/mcp/servidor-externo/ids";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const CONTATO = "11111111-1111-4111-8111-111111111111";

const FERRAMENTAS: FerramentaRemota[] = [
  { name: "consultar_agendamentos", somenteLeitura: true },
  { name: "sem_hint" },
  { name: "com_hint", somenteLeitura: true },
  { name: "crm_get_contact", somenteLeitura: true },
];

const auth = {
  organizationId: ORG,
  role: "ai_operator",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  scopes: ["mcp:read", "mcp:write"],
} as unknown as McpAuthResult;

function montar(toolIds: string[], opts: { contato?: string; identidadeDoContato?: string } = {}) {
  const supabase = { from: () => ({}) } as never;
  const leiturasRemotas = new Set<string>();
  const tools = pickToolsFromMcp({
    supabase,
    ctx: {
      organizationId: ORG,
      role: auth.role,
      actor: auth.actor,
      apiTokenId: auth.apiTokenId,
      requestId: "3f7c1e50-0000-4000-8800-000000000484",
      supabase,
    } as unknown as McpContext,
    auth,
    toolIds,
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    ...(opts.contato ? { contatoDoTurno: opts.contato } : {}),
    servidorMcpExterno: {
      servidor: { endpoint: "https://erp.clinica/mcp", chave: "segredo" },
      ferramentas: FERRAMENTAS,
      ...(opts.identidadeDoContato ? { contato: opts.identidadeDoContato } : {}),
    },
    leiturasRemotas,
  });
  return { tools, leituras: [...leiturasRemotas] };
}

describe("o coletor de leituras remotas segue a classificação de quem monta", () => {
  it("leitura marcada pelo admin e declarada pelo servidor entra", () => {
    const { tools, leituras } = montar([toolIdRemoto("consultar_agendamentos", "leitura")]);
    expect(tools.consultar_agendamentos).toBeDefined();
    expect(leituras).toEqual(["consultar_agendamentos"]);
  });

  it("uma metade só não basta: monta como escrita e fica fora do coletor", () => {
    const { tools, leituras } = montar([
      toolIdRemoto("sem_hint", "leitura"),
      toolIdRemoto("com_hint", "escrita"),
    ]);
    expect(Object.keys(tools).sort()).toEqual(["com_hint", "sem_hint"]);
    expect(leituras).toEqual([]);
  });

  it("nome do catálogo compilado nunca é tratado como remota", () => {
    expect(montar([toolIdRemoto("crm_get_contact", "leitura")]).leituras).toEqual([]);
  });

  it("em conversa, sem a identidade do contato no servidor, a leitura não monta nem entra", () => {
    const { tools, leituras } = montar([toolIdRemoto("consultar_agendamentos", "leitura")], {
      contato: CONTATO,
    });
    expect(tools.consultar_agendamentos).toBeUndefined();
    expect(leituras).toEqual([]);
  });

  it("em conversa, com a identidade DESTE contato, entra", () => {
    const { leituras } = montar([toolIdRemoto("consultar_agendamentos", "leitura")], {
      contato: CONTATO,
      identidadeDoContato: CONTATO,
    });
    expect(leituras).toEqual(["consultar_agendamentos"]);
  });
});
