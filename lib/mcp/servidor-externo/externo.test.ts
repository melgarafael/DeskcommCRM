// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * #2147 — registrar um servidor MCP externo e chamá-lo no turno do agente.
 *
 * O que este arquivo cobre, nas duas pontas do fatiamento:
 *
 *  1. REGISTRO: a gravação em `organizations.settings.mcp_externo` — SÓ o
 *     endpoint, com merge em dois níveis (o mesmo bolso de `conversions` no PR
 *     #2197). A CHAVE não mora mais aqui: vai cifrada para as colunas
 *     `mcp_externo_chave_*` (migration 0580), porque a RLS do `settings`
 *     entregava o jsonb a todo membro, inclusive viewer.
 *  2. INVOCAÇÃO: um servidor Streamable HTTP de mentira, no processo, falando
 *     o contrato MCP (`initialize` / `tools/list` / `tools/call`) — é a prova
 *     de que a chamada sai com a chave no cabeçalho e volta com a frase. Nenhum
 *     teste daqui depende de rede: o ERP real nunca é contatado. A saída passa
 *     pelo guard anti-SSRF (item 4), que este arquivo injeta só para o stub do
 *     `127.0.0.1` conviver com ele.
 *  3. TURNO: com registro E escolha do agente, `pickToolsFromMcp` entrega a
 *     ferramenta remota ao modelo; sem escolha, sem servidor ou sem registro,
 *     o catálogo compilado é exatamente o de antes (itens 6 e 7).
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

// A resolução de DNS é a fronteira do `assertDestinoResolvidoSeguro` DEFAULT:
// por padrão delega ao `lookup` real (os stubs daqui moram em IP literal, que
// não passa por DNS), e o teste da peça de DNS troca a resposta numa chamada só.
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  return { ...real, lookup: vi.fn(real.lookup) };
});

// A chave de cifragem da instalação tem de existir ANTES de `lib/env.ts` ser
// carregado — é ela que a descoberta usa para ABRIR a chave das colunas.
vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";
import { chamarFerramentaRemota, fetchDeSaida, listarFerramentasDoServidor } from "./chamada";
import { lookup } from "node:dns/promises";
import { carregarServidorMcpExterno, carregarServidorMcpExternoDoTurno } from "./carregar";
import { lerEndpointMcpExterno, mesclarServidorMcpExterno } from "./registro";
import { cifrarChaveMcpExterno } from "./segredo";
import { toolIdRemoto } from "./ids";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";

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
            // Declara leitura de verdade (item 8): sem isto a ferramenta sairia
            // como ESCRITA e o gate de funil a recusaria por vacuidade.
            annotations: { readOnlyHint: true },
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

/**
 * O guard anti-SSRF (item 4) com a ÚNICA exceção de que este teste precisa: o
 * ERP de mentira mora em `127.0.0.1`, faixa PRIVADA que o guard recusa de
 * propósito. Aqui só o loopback é deixado passar — a allowlist do host
 * cadastrado, o `redirect: "manual"` e a ordem das três peças continuam os de
 * produção, e o teste logo abaixo prova o que acontece sem esta injeção.
 */
function fetchDoStub() {
  return fetchDeSaida(base, {
    conferirUrl: (url) => {
      if (!url.startsWith(base)) assertSafeOutboundUrl(url);
    },
    conferirIp: async (host) => {
      if (host !== "127.0.0.1") await assertDestinoResolvidoSeguro(host);
    },
  });
}

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
    // E o bolso do MCP externo NÃO guarda mais a chave (item 3): ela vive
    // cifrada nas colunas, que a RLS não entrega a membro nenhum.
    expect(gravado.mcp_externo).toEqual({ endpoint: "https://erp.loja/mcp" });
    expect(JSON.stringify(gravado)).not.toContain(CHAVE);

    // E a leitura devolve o que foi gravado.
    expect(lerEndpointMcpExterno(gravado)).toBe("https://erp.loja/mcp");
  });

  it("endpoint vazio apaga o registro e devolve os outros bolsos como estavam", () => {
    const settings = {
      conversions: { meta_page_id: "111" },
      mcp_externo: { endpoint: "https://erp.loja/mcp", chave: CHAVE },
    };

    const gravado = mesclarServidorMcpExterno(settings, { endpoint: "", chave: "" });

    expect(gravado.mcp_externo).toBeUndefined();
    expect(gravado.conversions).toEqual({ meta_page_id: "111" });
    expect(lerEndpointMcpExterno(gravado)).toBeNull();
  });

  it("a leitura recusa o que não dá para chamar: sem registro, URL que não é http(s)", () => {
    expect(lerEndpointMcpExterno(undefined)).toBeNull();
    expect(lerEndpointMcpExterno(null)).toBeNull();
    expect(lerEndpointMcpExterno({})).toBeNull();
    expect(lerEndpointMcpExterno({ mcp_externo: { endpoint: "erp.loja/mcp" } })).toBeNull();
    expect(lerEndpointMcpExterno({ mcp_externo: { endpoint: "ftp://erp.loja" } })).toBeNull();
    expect(lerEndpointMcpExterno({ mcp_externo: { endpoint: 12 } })).toBeNull();
  });

  it("endereço com SEGREDO DENTRO não é registrável (item 5)", () => {
    // `?token=`, `#` e `user:senha` virariam dado eterno na trilha append-only e
    // no logger — a doutrina do repo proíbe chave em query string, e aqui ela
    // nem chega a ser gravada.
    expect(lerEndpointMcpExterno({ mcp_externo: { endpoint: "https://erp.loja/mcp?token=abc" } })).toBeNull();
    expect(lerEndpointMcpExterno({ mcp_externo: { endpoint: "https://erp.loja/mcp#abc" } })).toBeNull();
    expect(lerEndpointMcpExterno({ mcp_externo: { endpoint: "***@erp.loja/mcp" } })).toBeNull();
  });
});

// ─── Descoberta (a ponte entre registro e turno) ────────────────────────────

describe("descoberta das ferramentas anunciadas (#2147)", () => {
  function bancoCom(settings: unknown) {
    // A linha devolvida traz as QUATRO colunas cifradas: é por elas que a chave
    // abre (migration 0580) — o jsonb não tem chave nenhuma para entregar.
    const cifrado = cifrarChaveMcpExterno(CHAVE);
    const ids: Array<string | undefined> = [];
    const cadeia: Record<string, unknown> = {
      select: () => cadeia,
      eq: (coluna: string, valor: unknown) =>
        (ids.push(coluna === "id" ? (valor as string) : undefined), cadeia),
      maybeSingle: async () => ({ data: { settings, ...cifrado }, error: null }),
    };
    return { ids, cliente: { from: () => cadeia } as never };
  }

  it("sem registro devolve null e não contata rede nenhuma", async () => {
    const { cliente } = bancoCom({ proposals: { enabled: true } });
    expect(await carregarServidorMcpExterno(cliente, ORG)).toBeNull();
  });

  it("a leitura é SEMPRE pela organização do turno, nunca por um id vindo de fora (item 2)", async () => {
    const primeiro = bancoCom({ mcp_externo: { endpoint: base } });
    const segundo = bancoCom({ mcp_externo: { endpoint: base } });
    await carregarServidorMcpExterno(primeiro.cliente, "00000000-0000-4000-8000-000000000001");
    await carregarServidorMcpExterno(segundo.cliente, "00000000-0000-4000-8000-000000000002");
    expect(primeiro.ids).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(segundo.ids).toEqual(["00000000-0000-4000-8000-000000000002"]);
  });

  it("servidor registrado que não responde devolve null — o turno não morre por isso", async () => {
    const { cliente } = bancoCom({ mcp_externo: { endpoint: "http://127.0.0.1:1/mcp" } });
    expect(await carregarServidorMcpExterno(cliente, ORG, { fetch: fetchDoStub() })).toBeNull();
  });

  it("com registro devolve endpoint + chave ABERTA das colunas e o que o servidor anunciou", async () => {
    // A chave foi CIFRADA no banco e aberta aqui — o jsonb não a contém, e é
    // por isso que a descoberta é a prova de ponta a ponta da migration 0580.
    const { cliente, ids } = bancoCom({ mcp_externo: { endpoint: base } });
    const montado = await carregarServidorMcpExterno(cliente, ORG, { fetch: fetchDoStub() });
    expect(montado?.servidor).toEqual({ endpoint: base, chave: CHAVE });
    expect(montado?.ferramentas.map((f) => f.name)).toEqual(["erp_achar"]);
    expect(ids).toEqual([ORG]);
  });
});

describe("sem escolha no agente, NADA abre rede (#2147, item 7)", () => {
  // Registro EXISTENTE e servidor de pé: o único motivo para não haver rede é
  // o `tool_ids` do agente não ter escolha remota.
  function bancoRegistrado() {
    const consultas: string[] = [];
    const cadeia: Record<string, unknown> = {
      select: () => cadeia,
      eq: () => cadeia,
      maybeSingle: async () => ({
        data: { settings: { mcp_externo: { endpoint: base } }, ...cifrarChaveMcpExterno(CHAVE) },
        error: null,
      }),
    };
    return { consultas, cliente: { from: (t: string) => (consultas.push(t), cadeia) } as never };
  }
  function fetchEspiao() {
    const real = fetchDoStub();
    return vi.fn((...args: Parameters<typeof real>) => real(...args));
  }

  it("agente só com ferramentas compiladas: nem banco, nem fetch, nem byte no servidor", async () => {
    const { consultas, cliente } = bancoRegistrado();
    const espiao = fetchEspiao();
    const montado = await carregarServidorMcpExternoDoTurno(cliente, ORG, ["crm_search_products"], {
      fetch: espiao,
    });
    expect(montado).toBeNull();
    expect(espiao, "abriu rede sem escolha remota no agente").not.toHaveBeenCalled();
    expect(autorizacoesRecebidas, "o servidor remoto recebeu pedido").toEqual([]);
    expect(consultas).toEqual([]);
  });

  it("com escolha remota a descoberta acontece (o gate não é geral demais)", async () => {
    const { cliente } = bancoRegistrado();
    const espiao = fetchEspiao();
    const montado = await carregarServidorMcpExternoDoTurno(
      cliente,
      ORG,
      ["crm_search_products", toolIdRemoto("erp_achar", "leitura")],
      { fetch: espiao },
    );
    expect(montado?.ferramentas.map((f) => f.name)).toEqual(["erp_achar"]);
    expect(espiao).toHaveBeenCalled();
    expect(autorizacoesRecebidas.length).toBeGreaterThan(0);
  });
});

// ─── Invocação ──────────────────────────────────────────────────────────────

describe("invocação da ferramenta remota (#2147)", () => {
  it("lista as ferramentas do servidor com a chave no cabeçalho", async () => {
    const ferramentas = await listarFerramentasDoServidor(servidor(), { fetch: fetchDoStub() });
    expect(ferramentas.map((f) => f.name)).toEqual(["erp_achar"]);
    expect(autorizacoesRecebidas.at(-1)).toBe(`Bearer ${CHAVE}`);
  });

  it("chama e devolve a frase medida na issue, com os dados junto", async () => {
    const resultado = await chamarFerramentaRemota(servidor(), "erp_achar", {
      consulta: "pelicula iphone 15",
    }, { fetch: fetchDoStub() });

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
      chamarFerramentaRemota(servidor(), "erp_achar", { consulta: "comissao" }, { fetch: fetchDoStub() }),
    ).rejects.toThrow(/403/);
  });
});

// ─── O guard de saída (item 4) ──────────────────────────────────────────────

describe("a saída do processo passa pelo guard anti-SSRF (#2147, item 4)", () => {
  it("sem nenhuma opção injetada, o loopback NÃO sai — o default é o guard", async () => {
    await expect(
      chamarFerramentaRemota(servidor(), "erp_achar", { consulta: "oi" }),
    ).rejects.toThrow(/unsafe_url|private_host/);
    expect(autorizacoesRecebidas, "saiu byte antes da conferência").toEqual([]);
  });

  it("literal de metadados da nuvem é recusado no pedaço textual, sem rede", async () => {
    const guard = fetchDeSaida("https://erp.loja/mcp");
    await expect(guard("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /unsafe_url/,
    );
  });

  it("host fora do cadastrado falha fechado, antes do DNS", async () => {
    // O guard injetado SÓ relaxa o loopback; um host diferente do registrado
    // continua caindo na allowlist.
    const guard = fetchDeSaida(base, { conferirUrl: () => {} });
    await expect(guard("https://fora-da-allowlist.loja/mcp")).rejects.toThrow(/egress|fora/i);
  });

  it("host cadastrado que RESOLVE para faixa privada não sai — a peça de DNS é chamada", async () => {
    // O pedaço textual aceita `erp.loja`; quem barra o rebinding é a
    // resolução. Sem a chamada a `conferirIp`, o fetch sairia.
    const saidas: string[] = [];
    const guard = fetchDeSaida("https://erp.loja/mcp", {
      conferirUrl: () => {},
      conferirIp: async (host) => {
        throw new Error(`unsafe_url:private_ip ${host}`);
      },
      fetchImpl: (async (url: string) => {
        saidas.push(url);
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await expect(guard("https://erp.loja/mcp")).rejects.toThrow(/private_ip erp\.loja/);
    expect(saidas, "saiu byte sem conferir o IP resolvido").toEqual([]);
  });

  it("SEM `conferirIp` injetado, o default resolve o host e barra a faixa privada", async () => {
    // Nada de guarda injetada na peça de DNS: quem decide é o DEFAULT
    // (`assertDestinoResolvidoSeguro`), com a resolução real trocada só nesta
    // chamada. Se o default virar no-op, o fetch sai e este teste fica vermelho.
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }] as never);
    const saidas: string[] = [];
    const guard = fetchDeSaida("https://erp.loja/mcp", {
      conferirUrl: () => {},
      fetchImpl: (async (url: string) => {
        saidas.push(url);
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await expect(guard("https://erp.loja/mcp")).rejects.toThrow(/private_ip/);
    expect(vi.mocked(lookup)).toHaveBeenCalledWith("erp.loja", { all: true });
    expect(saidas, "saiu byte com o host resolvendo para 10.0.0.5").toEqual([]);
  });

  it("controle: o mesmo default deixa sair quando o host resolve para IP público", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never);
    const saidas: string[] = [];
    const guard = fetchDeSaida("https://erp.loja/mcp", {
      conferirUrl: () => {},
      fetchImpl: (async (url: string) => {
        saidas.push(url);
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    await guard("https://erp.loja/mcp");
    expect(saidas).toEqual(["https://erp.loja/mcp"]);
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

  it("com registro E ESCOLHA do agente a remota aparece ao lado das compiladas e executa", async () => {
    const supabase = bancoDeMentira();
    const montadas = pickToolsFromMcp({
      supabase: supabase as never,
      ctx: contexto(supabase),
      auth,
      // Item 6: a remota só entra pelo `tool_ids` do agente, com o prefixo.
      toolIds: ["crm_search_products", toolIdRemoto("erp_achar", "leitura")],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
      servidorMcpExterno: {
        servidor: { endpoint: base, chave: CHAVE },
        ferramentas: await listarFerramentasDoServidor(
          { endpoint: base, chave: CHAVE },
          { fetch: fetchDoStub() },
        ),
        // Junta de teste: sem ela o guard recusaria o loopback, que é
        // justamente o que o teste logo acima prova que ele faz.
        fetch: fetchDoStub(),
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

  it("servidor registrado mas agente SEM escolha: nada remoto monta (item 7)", () => {
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
        ferramentas: [{ name: "erp_achar" }],
      },
    });

    expect(Object.keys(montadas)).toEqual(["crm_search_products"]);
    expect(montadas.erp_achar).toBeUndefined();
  });

  it("agente com escolha mas SEM servidor registrado: o catálogo é o de antes (item 7)", () => {
    const supabase = bancoDeMentira();
    const montadas = pickToolsFromMcp({
      supabase: supabase as never,
      ctx: contexto(supabase),
      auth,
      toolIds: ["crm_search_products", toolIdRemoto("erp_achar", "escrita")],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
      // `servidorMcpExterno` ausente = `carregarServidorMcpExterno` devolveu
      // `null`: sem registro, sem descoberta, sem rede.
    });

    expect(Object.keys(montadas)).toEqual(["crm_search_products"]);
    expect(montadas.erp_achar).toBeUndefined();
  });
});
