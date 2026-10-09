import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * O servidor MCP PÚBLICO aplica a mesma regra do ingresso do agente (#484):
 * vazio declarado pela tool (`motivoDoVazio`) é auditado com `success: false`.
 * Antes, a mesma busca sem achado era `false` pelo agente e `true` por aqui.
 */
const auditSpy = vi.fn();
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: (e: unknown) => auditSpy(e) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const resposta = vi.hoisted(() => ({ atual: { produtos: [] as unknown[] } as unknown }));
vi.mock("@/lib/mcp/tools", () => ({
  allTools: [
    {
      name: "busca_de_mentira",
      description: "busca",
      inputSchema: { termo: z.string() },
      requiresRole: "viewer",
      requiresScope: "mcp:read",
      motivoDoVazio: (r: unknown) =>
        (r as { produtos: unknown[] }).produtos.length === 0 ? "nenhum produto casou o termo" : null,
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
      scopes: ["mcp:read"],
    },
    "req-1",
  );
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(cliente);
  await client.callTool({ name: "busca_de_mentira", arguments: { termo: "iphone" } });
  await client.close();
}

beforeEach(() => auditSpy.mockClear());

describe("servidor MCP público — busca vazia não é sucesso (#484)", () => {
  it("vazio declarado é auditado como success:false, com o motivo", async () => {
    resposta.atual = { produtos: [] };
    await chamar();
    expect(auditSpy).toHaveBeenCalledOnce();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        desfecho: "sem_resultado",
        motivo: "nenhum produto casou o termo",
      }),
    );
  });

  it("com achado, segue success:true e sem desfecho (controle)", async () => {
    resposta.atual = { produtos: [{ id: "p1" }] };
    await chamar();
    expect(auditSpy).toHaveBeenCalledOnce();
    // O tamanho do que voltou ao modelo, em bytes UTF-8 — sem isto, tirar o
    // `resultBytes` deste caminho não deixava vermelho nenhum.
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        resultBytes: Buffer.byteLength(JSON.stringify({ produtos: [{ id: "p1" }] }), "utf8"),
      }),
    );
    expect(auditSpy.mock.lastCall?.[0]).not.toHaveProperty("desfecho");
  });

  it("erro na tool é auditado sem resultBytes: não houve resposta a medir", async () => {
    resposta.atual = new Error("banco caiu");
    await chamar();
    expect(auditSpy).toHaveBeenCalledOnce();
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorMessage: "banco caiu" }));
    expect(auditSpy.mock.lastCall?.[0]).not.toHaveProperty("resultBytes");
  });
});
