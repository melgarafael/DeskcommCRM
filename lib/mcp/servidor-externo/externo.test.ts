// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * #2147 — registrar um servidor MCP externo e chamá-lo no turno do agente.
 *
 * O que este arquivo cobre, nas duas pontas do fatiamento:
 *
 *  1. REGISTRO: a gravação em `organizations.settings.mcp_externo` com merge
 *     em d ois níveis (o mesmo bolso de `conversions` no PR #2197) e a leitura
 *     que valida endpoint e chave. Sem migration — `settings` é jsonb e a linha
 *     já existe para toda organização.
 *  2. INVOCAÇÃO: um servidor Streamable HTTP de mentira, no processo, falando
 *     o contrato MCP (`initialize` / `tools/list` / `tools/call`) — é a prova
 *     de que a chamada sai com a chave no cabeçalho e volta com a frase. Nenhum
 *     teste daqui depende de rede: o ERP real nunca é contatado.
 *  3. TURNO: com registro, `pickToolsFromMcp` entrega a ferramenta remota ao
 *     modelo; sem registro, o catálogo compilado é exatamente o de antes.
 *
 * O stub devolve a MESMA frase medida na issue (`POST /api/bot/ferramentas/achar
 * → 200 {"frase":"Achei 5 ou mais produtos ...`), porque é o contrato que o
 * autor da issue já tem em mãos.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mesmo mock de `tests/unit/busca-vazia-nao-e-sucesso.test.ts`: a auditoria é
// a trilha que o painel de capacidades lê, então ela é observada, não sussurrada.
const auditSpy = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";
import { chamarFerramentaRemota, listarFerramentasDoServidor } from "./chamada";
import { carregarServidorMcpExterno } from "./carregar";
import { lerServidorMcpExterno, mesclarServidorMcpExterno } from "./registro";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const CHAVE = "chave-do-erp-123";
const FRASE = 'Achei 5 ou mais produtos com "pelicula iphone 15".';
const DADOS = {
  produtos: [{ name: "PELÍCULA 3D IPHONE 14 PRO / 15 / 15 PRO / 16", price: "79.9" }],
};

// ─── O stub: um servidor MCP Streamable HTTP dentro do próprio teste ────────
//
// Não é um mock da função — é a fronteira HTTP de verdade (socket, cabeçalho,
// corpo), que é a única forma de provar que a CHAVE sai junto e que o contrato
// falado é o do MCP. Responde `application/json` direto, que o transport do SDK
// aceita (uma resposta SSE exigiria um stream que não diria nada a mais).

let http: Server;
let base = "";
const autorizacoesRecebidas: Array<string | null | undefined> = [];
let ultimaChamada: { nome: unknown; argumentos: unknown } | null = null;

function responderA(mensagem: any): any | null {
  if (mensagem?.id === undefined || mensagem?.method === undefined) return null;
  const { id, method, params } = mensagem;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        // Ecoa a versão pedida: um servidor que devolve a própria versão é
        // recusado pelo cliente, e o teste morreria por协议, não por código.
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "erp-mcp-stub", version: "1.0.0" },
      },
    };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "erp_achar",
            description: "Busca preço, estoque e ordem de serviço consultando o ERP.",
            inputSchema: {
              type: "object",
              properties: { consulta: { type: "string", description: "O que procurar" } },
              required: ["consulta"],
            },
          },
        ],
      },
    };
  }
  if (method === "tools/call") {
    ultimaChamada = { nome: params?.name, argumentos: params?.arguments };
    // Mesma chave, pedindo comissão: o ERP diz 403 (issue #2147). A permissão
    // fica lá, onde o dado mora — o cliente só propaga o recuso.
    const recusado = String(params?.arguments?.consulta ?? "").includes("comissao");
    return {
      jsonrpc: "2.0",
      id,
      result: recusado
        ? { content: [{ type: "text", text: "403: seu nível não alcança comissão." }], isError: true }
        : {
            content: [{ type: "text", text: FRASE }],
            structuredContent: DADOS,
          },
    };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `método desconhecido: ${method}` } };
}

beforeAll(async () => {
  http = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    let corpo = "";
    req.on("data", (pedaco) => (corpo += pedaco));
    req.on("end", () => {
      autorizacoesRecebidas.push(req.headers.authorization);
      let mensagens: any[] = [];
      try {
        const bruto = JSON.parse(corpo || "[]");
        mensagens = Array.isArray(bruto) ? bruto : [bruto];
      } catch {
        res.writeHead(400).end();
        return;
      }
      const respostas = mensagens.map(responderA).filter((r) => r !== null);
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stub-1" });
      res.end(JSON.stringify(respostas.length === 1 ? respostas[0] : respostas));
    });
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((ok) => http.close(() => ok()));
});

beforeEach(() => {
  autorizacoesRecebidas.length = 0;
  ultimaChamada = null;
  auditSpy.mockClear();
});

const servidor = () => ({ endpoint: base, chave: CHAVE });

// ─── Registro ───────────────────────────────────────────────────────────────

describe("registro em organizations.settings.mcp_externo (#2147)", () => {
  it("mescla em dois níveis e preserva os outros bolsos do jsonb", () => {
    const settings = {
      conversions: { meta_page_id: "111" },
      proposals: { enabled: true },
      llm: { provider: "openai" },
    };

    const gravado = mesclarServidorMcpExterno(settings, {
      endpoint: "https://erp.loja/mcp",
      chave: CHAVE,
    });

    // O outro dono de `settings` continua intacto — é o bolso compartilhado.
    expect(gravado.conversions).toEqual({ meta_page_id: "111" });
    expect(gravado.proposals).toEqual({ enabled: true });
    expect(gravado.llm).toEqual({ provider: "openai" });
    expect(gravado.mcp_externo).toEqual({ endpoint: "https://erp.loja/mcp", chave: CHAVE });

    // E a leitura devolve o que foi gravado.
    expect(lerServidorMcpExterno(gravado)).toEqual({
      endpoint: "https://erp.loja/mcp",
      chave: CHAVE,
    });
  });

  it("endpoint vazio apaga o registro e devolve os outros bolsos como estavam", () => {
    const settings = {
      conversions: { meta_page_id: "111" },
      mcp_externo: { endpoint: "https://erp.loja/mcp", chave: CHAVE },
    };

    const gravado = mesclarServidorMcpExterno(settings, { endpoint: "", chave: "" });

    expect(gravado.mcp_externo).toBeUndefined();
    expect(gravado.conversions).toEqual({ meta_page_id: "111" });
    expect(lerServidorMcpExterno(gravado)).toBeNull();
  });

  it("a leitura recusa o que não dá para chamar: sem registro, URL que não é http(s), chave vazia", () => {
    expect(lerServidorMcpExterno(undefined)).toBeNull();
    expect(lerServidorMcpExterno(null)).toBeNull();
    expect(lerServidorMcpExterno({})).toBeNull();
    expect(lerServidorMcpExterno({ mcp_externo: { endpoint: "erp.loja/mcp", chave: CHAVE } })).toBeNull();
    expect(lerServidorMcpExterno({ mcp_externo: { endpoint: "ftp://erp.loja", chave: CHAVE } })).toBeNull();
    expect(lerServidorMcpExterno({ mcp_externo: { endpoint: "https://erp.loja", chave: "" } })).toBeNull();
    expect(lerServidorMcpExterno({ mcp_externo: { endpoint: 12, chave: CHAVE } })).toBeNull();
  });
});

// ─── Descoberta (a ponte entre registro e turno) ────────────────────────────

describe("descoberta das ferramentas anunciadas (#2147)", () => {
  function bancoCom(settings: unknown) {
    const cadeia: Record<string, unknown> = {
      select: () => cadeia,
      eq: () => cadeia,
      maybeSingle: async () => ({ data: { settings }, error: null }),
    };
    return { from: () => cadeia } as never;
  }

  it("sem registro devolve null e não contata rede nenhuma", async () => {
    const montado = await carregarServidorMcpExterno(bancoCom({ proposals: { enabled: true } }), ORG);
    expect(montado).toBeNull();
  });

  it("servidor registrado que não responde devolve null — o turno não morre por isso", async () => {
    const montado = await carregarServidorMcpExterno(
      bancoCom({ mcp_externo: { endpoint: "http://127.0.0.1:1/mcp", chave: CHAVE } }),
      ORG,
    );
    expect(montado).toBeNull();
  });

  it("com registro devolve endpoint + chave e as ferramentas que o servidor anunciou", async () => {
    const montado = await carregarServidorMcpExterno(
      bancoCom({ mcp_externo: { endpoint: base, chave: CHAVE } }),
      ORG,
    );
    expect(montado?.servidor).toEqual({ endpoint: base, chave: CHAVE });
    expect(montado?.ferramentas.map((f) => f.name)).toEqual(["erp_achar"]);
  });
});

// ─── Invocação ──────────────────────────────────────────────────────────────

describe("invocação da ferramenta remota (#2147)", () => {
  it("lista as ferramentas do servidor com a chave no cabeçalho", async () => {
    const ferramentas = await listarFerramentasDoServidor(servidor());
    expect(ferramentas.map((f) => f.name)).toEqual(["erp_achar"]);
    expect(autorizacoesRecebidas.at(-1)).toBe(`Bearer ${CHAVE}`);
  });

  it("chama e devolve a frase medida na issue, com os dados junto", async () => {
    const resultado = await chamarFerramentaRemota(servidor(), "erp_achar", {
      consulta: "pelicula iphone 15",
    });

    expect(resultado.texto).toBe(FRASE);
    expect(resultado.dados).toEqual(DADOS);
    expect(autorizacoesRecebidas.at(-1)).toBe(`Bearer ${CHAVE}`);
    expect(ultimaChamada).toMatchObject({
      nome: "erp_achar",
      argumentos: { consulta: "pelicula iphone 15" },
    });
  });

  it("o 403 do ERP sobe como erro — a permissão continua morando no servidor", async () => {
    await expect(
      chamarFerramentaRemota(servidor(), "erp_achar", { consulta: "comissao" }),
    ).rejects.toThrow(/403/);
  });
});

// ─── O turno do agente ──────────────────────────────────────────────────────

const auth = {
  organizationId: ORG,
  role: "ai_operator",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  scopes: ["mcp:read", "mcp:write"],
} as unknown as McpAuthResult;

function contexto(supabase: unknown): McpContext {
  return {
    organizationId: ORG,
    role: auth.role,
    actor: auth.actor,
    apiTokenId: auth.apiTokenId,
    requestId: "3f7c1e50-0000-4000-8000-000000000484",
    supabase,
  } as unknown as McpContext;
}

function bancoDeMentira() {
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: () => cadeia,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  return { from: () => cadeia };
}

describe("o turno do agente enxerga e chama a ferramenta remota (#2147)", () => {
  it("sem registro nada muda: só o catálogo compilado está no turno", () => {
    const montadas = pickToolsFromMcp({
      supabase: bancoDeMentira() as never,
      ctx: contexto(bancoDeMentira()),
      auth,
      toolIds: ["crm_search_products"],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
    });

    expect(Object.keys(montadas)).toEqual(["crm_search_products"]);
    expect(montadas.erp_achar).toBeUndefined();
  });

  it("com registro a ferramenta remota aparece ao lado das compiladas e executa contra o servidor", async () => {
    const supabase = bancoDeMentira();
    const montadas = pickToolsFromMcp({
      supabase: supabase as never,
      ctx: contexto(supabase),
      auth,
      toolIds: ["crm_search_products"],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
      servidorMcpExterno: {
        servidor: { endpoint: base, chave: CHAVE },
        ferramentas: await listarFerramentasDoServidor({ endpoint: base, chave: CHAVE }),
      },
    });

    // Enxerga: a remota AO LADO da compilada, sem substituir nenhuma.
    expect(Object.keys(montadas).sort()).toEqual(["crm_search_products", "erp_achar"]);

    // Chama: o mesmo seam que o turno usa (auditoria, papel e escopo valem
    // para a ferramenta remota porque ela passa pelo MESMO wrapMcpTool).
    const ferramenta = montadas.erp_achar as unknown as {
      execute: (a: unknown) => Promise<unknown>;
    };
    const resposta = await ferramenta.execute({ consulta: "pelicula iphone 15" });

    expect(resposta).toEqual({ texto: FRASE, dados: DADOS });
    expect(ultimaChamada?.nome).toBe("erp_achar");

    const auditoria = auditSpy.mock.calls.at(-1)?.[0] as {
      action?: string;
      metadata?: Record<string, unknown>;
    };
    expect(auditoria.action).toBe("mcp.tool_called");
    expect(auditoria.metadata).toMatchObject({ tool_name: "erp_achar", success: true });
  });
});
