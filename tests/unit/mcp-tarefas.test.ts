/**
 * Testes unitários para as ferramentas MCP de Tarefas (`crm_tasks`).
 *
 * Cobre:
 *  1. Validação de schemas Zod (`crm_create_task`, `crm_list_tasks` e `crm_update_task`).
 *  2. Presença e metadados no catálogo amigável (`TOOL_CATALOG`).
 *  3. Garantia de isolamento multi-tenant (`organization_id = ctx.organizationId`).
 *  4. Execução dos handlers com mocks de Supabase e validação de responsáveis.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { TOOL_CATALOG } from "@/lib/mcp/tools/catalogo";
import { allTools } from "@/lib/mcp/tools";
import { crmCreateTask, crmListTasks, crmUpdateTask } from "@/lib/mcp/tools/tarefas";
import type { McpContext } from "@/lib/mcp/types";

describe("MCP Tools — Tarefas (crm_create_task, crm_list_tasks e crm_update_task)", () => {
  it("estão devidamente registradas no catálogo amigável e em allTools", () => {
    const catalogCreate = TOOL_CATALOG.find((t) => t.name === "crm_create_task");
    const catalogList = TOOL_CATALOG.find((t) => t.name === "crm_list_tasks");
    const catalogUpdate = TOOL_CATALOG.find((t) => t.name === "crm_update_task");

    expect(catalogCreate).toBeDefined();
    expect(catalogCreate?.rotulo).toBe("Criar tarefa da equipe");
    expect(catalogCreate?.papelMinimo).toBe("agent");

    expect(catalogList).toBeDefined();
    expect(catalogList?.rotulo).toBe("Listar tarefas da equipe");
    expect(catalogList?.papelMinimo).toBe("viewer");

    expect(catalogUpdate).toBeDefined();
    expect(catalogUpdate?.rotulo).toBe("Atualizar tarefa da equipe");
    expect(catalogUpdate?.papelMinimo).toBe("agent");

    const toolCreate = allTools.find((t) => t.name === "crm_create_task");
    const toolList = allTools.find((t) => t.name === "crm_list_tasks");
    const toolUpdate = allTools.find((t) => t.name === "crm_update_task");

    expect(toolCreate).toBeDefined();
    expect(toolList).toBeDefined();
    expect(toolUpdate).toBeDefined();
  });

  describe("Schema Zod — crm_create_task", () => {
    const schema = z.object(crmCreateTask.inputSchema);

    it("valida payload mínimo com sucesso e aplica default de priority", () => {
      const parsed = schema.parse({ title: "  Ligar para cliente da folha  " });
      expect(parsed.title).toBe("Ligar para cliente da folha");
      expect(parsed.priority).toBe("medium");
    });

    it("rejeita título vazio ou em branco", () => {
      expect(() => schema.parse({ title: "   " })).toThrow();
      expect(() => schema.parse({ title: "" })).toThrow();
    });

    it("rejeita UUID inválido em contact_id ou lead_id", () => {
      expect(() =>
        schema.parse({
          title: "Tarefa Teste",
          contact_id: "nao-e-um-uuid",
        }),
      ).toThrow();

      expect(() =>
        schema.parse({
          title: "Tarefa Teste",
          lead_id: "123-abc",
        }),
      ).toThrow();
    });

    it("aceita data ISO válida com timezone", () => {
      const parsed = schema.parse({
        title: "Prazo de entrega DAS",
        due_date: "2026-11-20T18:00:00Z",
        priority: "urgent",
      });
      expect(parsed.due_date).toBe("2026-11-20T18:00:00Z");
      expect(parsed.priority).toBe("urgent");
    });
  });

  describe("Schema Zod — crm_list_tasks", () => {
    const schema = z.object(crmListTasks.inputSchema);

    it("aceita objeto vazio e aplica limite default 50", () => {
      const parsed = schema.parse({});
      expect(parsed.limite).toBe(50);
    });

    it("aceita filtros de status e assigned_to", () => {
      const parsed1 = schema.parse({ status: "pending", assigned_to: "me" });
      expect(parsed1.status).toBe("pending");
      expect(parsed1.assigned_to).toBe("me");

      const parsed2 = schema.parse({ assigned_to: "ninguem" });
      expect(parsed2.assigned_to).toBe("ninguem");
    });

    it("rejeita limites fora do intervalo de 1 a 100", () => {
      expect(() => schema.parse({ limite: 0 })).toThrow();
      expect(() => schema.parse({ limite: 150 })).toThrow();
    });
  });

  describe("Schema Zod — crm_update_task", () => {
    const schema = z.object(crmUpdateTask.inputSchema);

    it("valida payload com task_id e status para conclusão", () => {
      const parsed = schema.parse({
        task_id: "11111111-2222-3333-4444-555555555555",
        status: "done",
      });
      expect(parsed.task_id).toBe("11111111-2222-3333-4444-555555555555");
      expect(parsed.status).toBe("done");
    });

    it("rejeita task_id que não seja UUID", () => {
      expect(() =>
        schema.parse({
          task_id: "invalido",
          status: "in_progress",
        }),
      ).toThrow();
    });
  });

  describe("Handler Execution — Isolamento Multi-tenant e Atualização", () => {
    it("garante que crm_create_task grava com organization_id do contexto autenticado", async () => {
      const fakeOrgId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const fakeUserId = "11111111-2222-3333-4444-555555555555";

      let capturedPayload: Record<string, unknown> | null = null;

      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          insert: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
            capturedPayload = payload;
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: "99999999-8888-7777-6666-555555555555",
                    organization_id: payload.organization_id,
                    title: payload.title,
                    description: payload.description,
                    due_date: payload.due_date,
                    priority: payload.priority,
                    status: "pending",
                    lead_id: null,
                    contact_id: null,
                    demanda_id: null,
                    assigned_to: null,
                    created_by: payload.created_by,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  },
                  error: null,
                }),
              }),
            };
          }),
        }),
      };

      const ctx: McpContext = {
        organizationId: fakeOrgId,
        role: "agent",
        actor: { type: "user", id: fakeUserId },
        apiTokenId: "token-1",
        requestId: "req-test-1",
        supabase: mockSupabase as unknown as McpContext["supabase"],
      };

      const result = await crmCreateTask.handler(
        {
          title: "Auditar balancete",
          description: "Conferir conciliação SCI",
          priority: "high",
        },
        ctx,
      );

      expect(capturedPayload).not.toBeNull();
      expect(capturedPayload?.organization_id).toBe(fakeOrgId);
      expect(capturedPayload?.created_by).toBe(fakeUserId);
      expect(capturedPayload?.title).toBe("Auditar balancete");
      expect(result.task).toBeDefined();
      expect(result.task.id).toBe("99999999-8888-7777-6666-555555555555");
    });

    it("garante que crm_update_task filtra estritamente por id e organization_id", async () => {
      const fakeOrgId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const fakeTaskId = "88888888-4444-2222-1111-999999999999";
      const eqCalls: [string, unknown][] = [];

      const mockQuery: any = {
        eq: vi.fn().mockImplementation((col: string, val: unknown) => {
          eqCalls.push([col, val]);
          return mockQuery;
        }),
        select: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: fakeTaskId,
              organization_id: fakeOrgId,
              title: "Tarefa de Teste",
              status: "done",
            },
            error: null,
          }),
        }),
      };

      const mockSupabase = {
        from: vi.fn().mockReturnValue({
          update: vi.fn().mockReturnValue(mockQuery),
        }),
      };

      const ctx: McpContext = {
        organizationId: fakeOrgId,
        role: "agent",
        actor: { type: "user", id: "user-1" },
        apiTokenId: "token-1",
        requestId: "req-test-update",
        supabase: mockSupabase as unknown as McpContext["supabase"],
      };

      const result = await crmUpdateTask.handler(
        {
          task_id: fakeTaskId,
          status: "done",
        },
        ctx,
      );

      expect(eqCalls).toContainEqual(["id", fakeTaskId]);
      expect(eqCalls).toContainEqual(["organization_id", fakeOrgId]);
      expect(result.task.status).toBe("done");
    });
  });
});
