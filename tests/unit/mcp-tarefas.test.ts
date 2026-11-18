/**
 * Testes unitários para as ferramentas MCP de Tarefas (`crm_tasks`).
 *
 * Cobre:
 *  1. Validação de schemas Zod (`crm_create_task`, `crm_list_tasks` e `crm_update_task`).
 *  2. Presença e metadados no catálogo amigável (`TOOL_CATALOG`).
 *  3. Garantia de isolamento multi-tenant (`organization_id = ctx.organizationId`).
 *  4. Execução dos handlers com mocks de Supabase e validação de responsáveis.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// A porta de SQL (conferência de vínculo), o audit e a linha do tempo são as
// saídas que estes casos aferem — dublês, para ler o que o handler mandou.
const queryOne = vi.fn();
vi.mock("@/lib/db", () => ({ portaDaAplicacao: () => ({ queryOne, query: vi.fn() }) }));
const audit = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
const registraAtividadeDaTarefa = vi.fn();
vi.mock("@/lib/tarefas/atividade", () => ({
  registraAtividadeDaTarefa: (...a: unknown[]) => registraAtividadeDaTarefa(...a),
}));

import { TOOL_CATALOG } from "@/lib/mcp/tools/catalogo";
import { allTools } from "@/lib/mcp/tools";
import { crmCreateTask, crmListTasks, crmUpdateTask } from "@/lib/mcp/tools/tarefas";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TAREFA = "88888888-4444-4222-8111-999999999999";
const OUTRO_ID = "77777777-4444-4222-8111-999999999999";
const CONTATO_DO_TURNO = "66666666-4444-4222-8111-999999999999";

type Resposta = { data: unknown; error: null };

/** Cadeia do PostgREST que anota cada chamada e devolve as respostas em ordem. */
function bancoFalso(respostas: Resposta[]) {
  const chamadas: Array<[string, unknown[]]> = [];
  const fila = [...respostas];
  const cadeia: Record<string, unknown> = {
    maybeSingle: async () => fila.shift(),
    single: async () => fila.shift(),
    then: (resolver: (r: Resposta | undefined) => unknown) => resolver(fila.shift()),
  };
  for (const metodo of ["select", "eq", "update", "insert", "is", "gte", "lte", "order", "limit"]) {
    cadeia[metodo] = (...args: unknown[]) => {
      chamadas.push([metodo, args]);
      return cadeia;
    };
  }
  return { supabase: { from: () => cadeia } as unknown as McpContext["supabase"], chamadas };
}

function contexto(supabase: McpContext["supabase"]): McpContext {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "user", id: "11111111-2222-4333-8444-555555555555" },
    apiTokenId: "token-1",
    requestId: "req-test",
    supabase,
  };
}

beforeEach(() => {
  queryOne.mockReset();
  audit.mockReset();
  registraAtividadeDaTarefa.mockReset();
});

describe("MCP Tools — Tarefas (crm_create_task, crm_list_tasks e crm_update_task)", () => {
  it("estão devidamente registradas no catálogo amigável e em allTools", () => {
    const catalogCreate = TOOL_CATALOG.find((t) => t.name === "crm_create_task");
    const catalogList = TOOL_CATALOG.find((t) => t.name === "crm_list_tasks");
    const catalogUpdate = TOOL_CATALOG.find((t) => t.name === "crm_update_task");

    expect(catalogCreate?.rotulo).toBe("Criar tarefa da equipe");
    expect(catalogList?.rotulo).toBe("Listar tarefas da equipe");
    expect(catalogUpdate?.rotulo).toBe("Atualizar tarefa da equipe");

    // O papel mínimo mora na definição da tool, não no catálogo — e é o mesmo
    // da REST `/api/v1/tasks` (viewer lê, agent escreve).
    const papel = (nome: string) => allTools.find((t) => t.name === nome)?.requiresRole;
    expect(papel("crm_create_task")).toBe("agent");
    expect(papel("crm_list_tasks")).toBe("viewer");
    expect(papel("crm_update_task")).toBe("agent");
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
        task_id: "11111111-2222-4333-8444-555555555555",
        status: "done",
      });
      expect(parsed.task_id).toBe("11111111-2222-4333-8444-555555555555");
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
      const fakeUserId = "11111111-2222-4333-8444-555555555555";

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

      const result = (await crmCreateTask.handler(
        {
          title: "Auditar balancete",
          description: "Conferir conciliação SCI",
          priority: "high",
        },
        ctx,
      )) as { task: { id: string } };

      // `capturedPayload` é atribuído dentro do dublê (closure): sem reler com o
      // tipo declarado, o TS estreita para `null` e o acesso vira `never`.
      const payload = capturedPayload as Record<string, unknown> | null;
      expect(payload).not.toBeNull();
      expect(payload?.organization_id).toBe(fakeOrgId);
      expect(payload?.created_by).toBe(fakeUserId);
      expect(payload?.title).toBe("Auditar balancete");
      expect(result.task).toBeDefined();
      expect(result.task.id).toBe("99999999-8888-7777-6666-555555555555");
    });

    it("crm_create_task recusa negócio que não é desta organização, sem gravar", async () => {
      queryOne.mockResolvedValueOnce(null);
      const { supabase, chamadas } = bancoFalso([]);

      await expect(
        crmCreateTask.handler(
          { title: "Ligar", priority: "medium", lead_id: OUTRO_ID },
          contexto(supabase),
        ),
      ).rejects.toThrow("O negócio, o contato ou a demanda vinculada não existe.");

      expect(queryOne).toHaveBeenCalledWith(expect.stringContaining("organization_id = $2"), [OUTRO_ID, ORG]);
      expect(chamadas.map(([m]) => m)).not.toContain("insert");
    });

    it("crm_update_task filtra por id e organization_id e registra a conclusão só na transição", async () => {
      const tarefa = { id: TAREFA, organization_id: ORG, title: "Tarefa", status: "done", lead_id: OUTRO_ID };
      const { supabase, chamadas } = bancoFalso([
        { data: { status: "pending" }, error: null },
        { data: tarefa, error: null },
      ]);

      const result = (await crmUpdateTask.handler({ task_id: TAREFA, status: "done" }, contexto(supabase))) as {
        task: { status: string };
      };

      expect(chamadas).toContainEqual(["eq", ["id", TAREFA]]);
      expect(chamadas).toContainEqual(["eq", ["organization_id", ORG]]);
      expect(chamadas).toContainEqual(["update", [{ status: "done" }]]);
      expect(result.task.status).toBe("done");
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { campos: ["status"], de: "pending", para: "done" } }),
      );
      expect(registraAtividadeDaTarefa).toHaveBeenCalledTimes(1);
    });

    it("concluir de novo uma tarefa já concluída não grava segunda linha na timeline", async () => {
      const tarefa = { id: TAREFA, organization_id: ORG, title: "Tarefa", status: "done", lead_id: OUTRO_ID };
      const { supabase } = bancoFalso([
        { data: { status: "done" }, error: null },
        { data: tarefa, error: null },
      ]);

      await crmUpdateTask.handler({ task_id: TAREFA, status: "done" }, contexto(supabase));

      expect(registraAtividadeDaTarefa).not.toHaveBeenCalled();
    });

    it("crm_list_tasks no turno lista só as tarefas do contato da conversa", async () => {
      const { supabase, chamadas } = bancoFalso([{ data: [], error: null }]);

      await crmListTasks.handler(
        { limite: 50, contact_id: OUTRO_ID },
        { ...contexto(supabase), contatoDoTurno: CONTATO_DO_TURNO },
      );

      expect(chamadas).toContainEqual(["eq", ["contact_id", CONTATO_DO_TURNO]]);
      expect(chamadas).not.toContainEqual(["eq", ["contact_id", OUTRO_ID]]);
    });
  });
});
