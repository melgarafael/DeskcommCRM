import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EMPRESA SUSPENSA: NO MCP SÓ A FERRAMENTA DE PRIVACIDADE RESPONDE
 * (decisão do dono de 30/09 sobre o PR 1; spec da cobrança §4: "LGPD nunca é
 * bloqueada", "Bearer `dsk_` e MCP: 403").
 *
 * O `/api/mcp` autentica o token da empresa parada marcando-o `orgSuspensa`, e
 * o servidor recusa toda ferramenta que não declara `permiteOrgSuspensa` —
 * DENTRO do `try` que audita e DEPOIS do teto, para a integração em laço não
 * escrever auditoria sem freio. As demais portas de token (`auth-dual`) seguem
 * 403: só quem passa a opção abre a porta.
 */
const auditSpy = vi.fn();
const tetoSpy = vi.fn(async () => undefined);
const tabelas: string[] = [];
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: (e: unknown) => auditSpy(e) }));
vi.mock("@/lib/mcp/rate-limit", () => ({ verificarTetoMcp: (...a: unknown[]) => tetoSpy(...(a as [])) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      tabelas.push(tabela);
      if (tabela !== "lgpd_requests") throw new Error(`tabela_inesperada:${tabela}`);
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) c[m] = () => c;
      c.then = (ok: (v: unknown) => unknown) =>
        ok({ data: [{ id: "p1", request_type: "redact", status: "pending" }], error: null });
      return c;
    },
  }),
}));

const { createMcpServer } = await import("@/lib/mcp/server");
const { allTools } = await import("@/lib/mcp/tools");

const AUTH = {
  organizationId: "00000000-0000-4000-8000-00000000000b",
  role: "admin" as const,
  actor: { type: "api_token" as const, id: "tok", role: "admin" as const },
  apiTokenId: "tok",
  scopes: ["mcp:read"],
};

async function chamar(orgSuspensa: boolean, name: string, args: Record<string, unknown>) {
  const server = createMcpServer(orgSuspensa ? { ...AUTH, orgSuspensa: true } : AUTH, "req-1");
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(cliente);
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  return { isError: r.isError === true, texto: r.content[0]?.text ?? "" };
}

beforeEach(() => {
  auditSpy.mockClear();
  tetoSpy.mockClear();
  tabelas.length = 0;
});

describe("MCP com a empresa suspensa", () => {
  it("só a ferramenta de privacidade declara que atende empresa suspensa", () => {
    expect(allTools.filter((t) => t.permiteOrgSuspensa).map((t) => t.name)).toEqual([
      "crm_list_privacy_requests",
    ]);
  });

  it("empresa suspensa + ferramenta de privacidade → responde", async () => {
    const r = await chamar(true, "crm_list_privacy_requests", {});
    expect(r.isError, r.texto).toBe(false);
    expect(JSON.parse(r.texto).pedidos).toHaveLength(1);
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("empresa suspensa + qualquer outra ferramenta → recusada antes da tool, auditada e contada no teto", async () => {
    const r = await chamar(true, "crm_search_contacts", { query: "ana" });
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/suspended/i);
    expect(tabelas, "a tool rodou com a empresa suspensa").toEqual([]);
    expect(tetoSpy).toHaveBeenCalledOnce();
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it("controle: empresa que opera chega ao handler da outra ferramenta", async () => {
    const r = await chamar(false, "crm_search_contacts", { query: "ana" });
    expect(r.texto).not.toMatch(/suspended/i);
    expect(tabelas).toContain("contacts");
  });
});
