import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * PELA ROTA MCP EXTERNA, RECUSA SEM EFEITO NÃO É `success: true` (#4343).
 *
 * Medido na prova do #3328: `crm_create_lead` recusou com `sem_destino` pela
 * rota MCP real, nenhum negócio nasceu, e a linha de `api_audit_log` gravou
 * `success: true`. A trilha afirmava uma mutação que não aconteceu.
 *
 * O caminho comum é o mesmo do ingresso do agente: `lib/mcp/desfecho-da-chamada.ts`.
 * A auditoria passa a gravar `success: false` com o CÓDIGO da recusa.
 */
const auditSpy = vi.fn();
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: (e: unknown) => auditSpy(e) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const resposta = vi.hoisted(() => ({ atual: {} as unknown }));
vi.mock("@/lib/mcp/tools", () => ({
  allTools: [
    {
      name: "crm_create_lead",
      description: "cria negócio",
      inputSchema: { pipeline_id: z.string().uuid() },
      category: "write",
      requiresRole: "agent",
      requiresScope: "mcp:write",
      handler: async () => {
        if (resposta.atual instanceof Error) throw resposta.atual;
        return resposta.atual;
      },
    },
  ],
}));

const { createMcpServer } = await import("@/lib/mcp/server");

async function chamar() {
  const server = createMcpServer(
    {
      organizationId: "00000000-0000-4000-8000-000000000001",
      role: "admin",
      actor: { type: "user", id: "00000000-0000-4000-8000-000000000002" },
      apiTokenId: "tok",
      scopes: ["mcp:write"],
    },
    "req-1",
  );
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(cliente);
  await client.callTool({
    name: "crm_create_lead",
    arguments: { pipeline_id: "00000000-0000-4000-8000-000000000009" },
  });
  await client.close();
}

beforeEach(() => auditSpy.mockClear());

describe("servidor MCP público — recusa sem efeito não é sucesso (#4343)", () => {
  it("`{ erro: 'sem_destino', mensagem }` é auditado como success:false, com o código", async () => {
    resposta.atual = {
      erro: "sem_destino",
      mensagem: "esta receita não aponta para nenhum funil — nenhum negócio foi criado.",
    };
    await chamar();

    expect(auditSpy).toHaveBeenCalledOnce();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorMessage: expect.stringContaining("sem_destino"),
        desfecho: "recusa",
        motivo: "sem_destino",
      }),
    );
  });

  it("CONTROLE POSITIVO: negócio criado continua success:true e sem desfecho de recusa", async () => {
    resposta.atual = { lead: { id: "33333333-3333-4333-8333-333333333333" } };
    await chamar();

    expect(auditSpy).toHaveBeenCalledOnce();
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(auditSpy.mock.lastCall?.[0]).not.toHaveProperty("desfecho");
  });
});
