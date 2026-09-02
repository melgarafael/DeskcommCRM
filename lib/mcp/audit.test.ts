import { describe, it, expect, vi, beforeEach } from "vitest";

const auditSpy = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));

import { auditMcpToolCall } from "./audit";
import type { McpContext } from "./types";

const ctx = {
  organizationId: "bcc12320-f555-4fef-8d90-38a0ac5950e0",
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  requestId: "req-1",
  // Um token comum vira actor.type='user' com id = id do TOKEN (lib/mcp/auth.ts).
  actor: { type: "user", id: "d7ba0e68-0000-4000-8000-000000000001", role: "manager" },
} as unknown as McpContext;

describe("auditMcpToolCall", () => {
  beforeEach(() => auditSpy.mockClear());

  it("não manda o nome da tool em resource_id (coluna uuid no banco)", async () => {
    // Defeito de origem: resourceId recebia "crm_create_lead" e todo insert
    // morria com «invalid input syntax for type uuid», em silêncio — nenhuma
    // chamada MCP era auditada.
    await auditMcpToolCall({
      ctx, toolName: "crm_create_lead", args: {}, durationMs: 12, success: true,
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.resourceId).toBeNull();
    expect(e.resourceType).toBe("mcp_tool");
    expect(e.metadata.tool_name).toBe("crm_create_lead");
  });

  it("não manda id de token em actorUserId (FK para auth.users)", async () => {
    await auditMcpToolCall({
      ctx, toolName: "crm_list_leads", args: {}, durationMs: 5, success: true,
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.actorUserId).toBeNull();
    expect(e.actorApiTokenId).toBe(ctx.apiTokenId);
  });

  it("escreve os campos de que o painel de uso depende para ler", async () => {
    // Contrato entre as duas pontas. `fn_agent_tool_usage` (migration 0103)
    // agrega por `action='mcp.tool_called'`, lê `metadata->>'tool_name'`,
    // conta falha por `metadata->>'success' = 'false'` e amarra a chamada ao
    // agente por `request_id = ai_agent_runs.id`. Renomear qualquer um destes
    // aqui zera o painel na tela sem quebrar teste nenhum do emissor — e "0
    // usos" é indistinguível de "nunca usada".
    await auditMcpToolCall({
      ctx, toolName: "crm_move_lead_stage", args: {}, durationMs: 9,
      success: false, errorMessage: "stage_not_found",
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.action).toBe("mcp.tool_called");
    expect(e.requestId).toBe(ctx.requestId);
    expect(e.metadata.tool_name).toBe("crm_move_lead_stage");
    expect(e.metadata.success).toBe(false);
  });

  it("redige segredos nos argumentos", async () => {
    await auditMcpToolCall({
      ctx, toolName: "crm_get_contact", args: { nuit: "12345678900", query: "joana" },
      durationMs: 3, success: true,
    });
    const e = auditSpy.mock.calls[0]![0];
    expect(e.metadata.args.nuit).toBe("[redacted]");
    expect(e.metadata.args.query).toBe("joana");
  });
});
