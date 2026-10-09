import { describe, it, expect, vi, beforeEach } from "vitest";

// A escrita da auditoria é observada aqui porque é ELA que o painel de
// capacidades lê: `fn_agent_tool_usage` (migration 0103) agrega por
// `action = 'mcp.tool_called'`, lê `metadata->>'tool_name'` e conta falha por
// `metadata->>'success' = 'false'`. Mesmo mock de `lib/mcp/audit.test.ts`.
const auditSpy = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import { auditMcpToolCall } from "@/lib/mcp/audit";
import type { McpAuthResult } from "@/lib/mcp/auth";
import { crmListContactOrders, crmSearchProducts, motivoDoVazioDaBusca } from "@/lib/mcp/tools/comercio";
import type { McpContext } from "@/lib/mcp/types";

/** Uma linha de catálogo como a busca a recebe do banco. */
function produto(over: Record<string, unknown> = {}) {
  return {
    id: "1a1f5f4e-0000-4000-8000-000000000001",
    codigo: "SKU-1",
    nome: "iPhone 15 Pro",
    descricao: null,
    marca: null,
    categoria: null,
    preco_cents: 799000,
    moeda: "BRL",
    controla_estoque: true,
    quantidade: 3,
    ...over,
  };
}

/**
 * `ctx.supabase` mínimo: encadeável e sempre aguardável.
 *
 * A busca pagina com `.range()`, então as páginas saem na ordem, uma por
 * chamada — é o que monta catálogo vazio, catálogo com achado e varredura
 * parcial sem banco. `count` é o `{ count: "exact" }` do select e chega junto
 * da página.
 */
function bancoDeMentira(paginas: Array<{ linhas: unknown[]; count: number | null }>) {
  const fila = [...paginas];
  const proxima = () => {
    const p = fila.shift() ?? { linhas: [] as unknown[], count: 0 };
    return { data: p.linhas, error: null, count: p.count };
  };
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: () => cadeia,
    order: () => cadeia,
    in: () => cadeia,
    is: () => cadeia,
    range: () => Promise.resolve(proxima()),
    limit: () => Promise.resolve(proxima()),
    maybeSingle: () => Promise.resolve({ data: null, error: null, count: null }),
    // Caminho que aguarda a cadeia direto (sem `.range()`) resolve a página da vez.
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(proxima()).then(resolve),
  };
  return { from: () => cadeia };
}

const auth = {
  organizationId: "bcc12320-f555-4fef-8d90-38a0ac5950e0",
  role: "ai_operator",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  scopes: ["mcp:read", "mcp:write"],
} as unknown as McpAuthResult;

function contexto(supabase: unknown): McpContext {
  return {
    organizationId: auth.organizationId,
    role: auth.role,
    actor: auth.actor,
    apiTokenId: auth.apiTokenId,
    requestId: "3f7c1e50-0000-4000-8000-000000000484",
    supabase,
  } as unknown as McpContext;
}

type Evento = { metadata: Record<string, unknown> };

/** Monta a tool pelo MESMO seam do turno do agente e devolve o que foi auditado. */
async function rodar(
  nomeDaTool: string,
  paginas: Array<{ linhas: unknown[]; count: number | null }>,
  args: Record<string, unknown>,
) {
  const supabase = bancoDeMentira(paginas);
  const ctx = contexto(supabase);
  const montadas = pickToolsFromMcp({
    supabase: supabase as never,
    ctx,
    auth,
    toolIds: [nomeDaTool],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
  });

  const ferramenta = montadas[nomeDaTool];
  expect(ferramenta, `a capacidade ${nomeDaTool} não foi montada no turno`).toBeDefined();
  const { execute } = ferramenta as unknown as { execute: (a: unknown) => Promise<unknown> };
  const resposta = await execute(args);
  const auditorias = auditSpy.mock.calls.map((c) => c[0] as Evento);
  return { resposta, auditoria: auditorias.at(-1) };
}

describe("busca de produtos do agente: 'não achei' não é sucesso (#484)", () => {
  beforeEach(() => auditSpy.mockClear());

  it("catálogo sem nada que case vira falha auditada, com o motivo declarado", async () => {
    const { resposta, auditoria } = await rodar(
      crmSearchProducts.name,
      [{ linhas: [], count: 0 }],
      { termo: "iphone", somente_disponiveis: true },
    );

    // 1) A conversa NÃO muda: o modelo continua recebendo a resposta honesta.
    //    O defeito era a auditoria, não a fala do agente.
    expect(resposta).toMatchObject({ produtos: [] });
    expect((resposta as { mensagem: string }).mensagem).toContain("não há nada com esse nome");

    // 2) A auditoria para de dizer sucesso — é esse `success: false` que
    //    `fn_agent_tool_usage` conta como falha.
    expect(auditoria?.metadata.tool_name).toBe("crm_search_products");
    expect(auditoria?.metadata.success).toBe(false);
    expect(auditoria?.metadata.desfecho).toBe("sem_resultado");
    expect(auditoria?.metadata.motivo).toBe("nao_encontrado");
  });

  it("produto existe mas está sem estoque: falha também, e o motivo é outro", async () => {
    const { resposta, auditoria } = await rodar(
      crmSearchProducts.name,
      [{ linhas: [produto({ quantidade: 0 })], count: 1 }],
      { termo: "iphone", somente_disponiveis: true },
    );

    expect((resposta as { mensagem: string }).mensagem).toContain("sem estoque");
    expect(auditoria?.metadata.success).toBe(false);
    // "não achei NADA" e "achei e não dá para vender" são vazios diferentes:
    // sem isso o dono não sabe se falta cadastro ou se falta reposição.
    expect(auditoria?.metadata.motivo).toBe("sem_estoque");
  });

  it("quem ACHA continua sucesso (o conserto não virou falha geral)", async () => {
    const { resposta, auditoria } = await rodar(
      crmSearchProducts.name,
      [{ linhas: [produto()], count: 1 }],
      { termo: "iphone", somente_disponiveis: true },
    );

    expect((resposta as { produtos: unknown[] }).produtos).toHaveLength(1);
    expect(auditoria?.metadata.success).toBe(true);
    expect(auditoria?.metadata).not.toHaveProperty("desfecho");
    // O tamanho, em bytes UTF-8, do que voltou ao modelo — e só o número.
    expect(auditoria?.metadata.result_bytes).toBe(Buffer.byteLength(JSON.stringify(resposta), "utf8"));
  });

  it("vazio que é RESPOSTA continua sucesso: contato sem pedidos", async () => {
    // Controle por tool: lista vazia de pedidos é resposta legítima ("o cliente
    // não comprou"), não falha. Só quem declara `motivoDoVazio` é afetado —
    // marcar todo vazio de toda tool seria transformar o normal em alarme.
    const { resposta, auditoria } = await rodar(crmListContactOrders.name, [{ linhas: [], count: 0 }], {
      contact_id: "bcc12320-f555-4fef-8d90-38a0ac5950e0",
      limite: 5,
    });

    expect((resposta as { pedidos: unknown[] }).pedidos).toEqual([]);
    expect(auditoria?.metadata.success).toBe(true);
  });
});

describe("o que o painel passa a poder contar", () => {
  beforeEach(() => auditSpy.mockClear());

  it("auditMcpToolCall leva desfecho e motivo para metadata", async () => {
    await auditMcpToolCall({
      ctx: contexto(bancoDeMentira([])),
      toolName: "crm_search_products",
      args: { termo: "iphone" },
      durationMs: 7,
      success: false,
      desfecho: "sem_resultado",
      motivo: "nao_encontrado",
    });

    const evento = auditSpy.mock.calls[0]![0] as Evento;
    expect(evento.metadata).toMatchObject({
      success: false,
      desfecho: "sem_resultado",
      motivo: "nao_encontrado",
    });
    // O que torna o vazio contável por loja/termo em vez de só "falhou".
    expect(evento.metadata.tool_name).toBe("crm_search_products");
  });

  it("chamada sem desfecho não ganha as chaves (nada muda para quem não declara)", async () => {
    await auditMcpToolCall({
      ctx: contexto(bancoDeMentira([])),
      toolName: "crm_list_leads",
      args: {},
      durationMs: 4,
      success: true,
    });

    const evento = auditSpy.mock.calls[0]![0] as Evento;
    expect(evento.metadata.success).toBe(true);
    expect(evento.metadata).not.toHaveProperty("desfecho");
    expect(evento.metadata).not.toHaveProperty("motivo");
  });
});

describe("motivoDoVazioDaBusca: só vazio DECLARADO conta", () => {
  it("lista com item nunca é vazio, por mais que o motivo apareça", () => {
    expect(motivoDoVazioDaBusca({ produtos: [produto()], motivo: "nao_encontrado" })).toBeNull();
  });

  it("vazio sem motivo continua sucesso — foi o que o defeito exigia para não alastrar", () => {
    expect(motivoDoVazioDaBusca({ produtos: [] })).toBeNull();
    expect(motivoDoVazioDaBusca({ produtos: [], motivo: "" })).toBeNull();
    expect(motivoDoVazioDaBusca(null)).toBeNull();
  });

  it("vazio com motivo devolve o motivo, que é o que a auditoria grava", () => {
    expect(motivoDoVazioDaBusca({ produtos: [], motivo: "varredura_parcial" })).toBe("varredura_parcial");
  });
});
