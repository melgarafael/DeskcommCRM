// @vitest-environment node
/**
 * #4445 — ESCRITA de servidor MCP externo DURANTE o atendimento, com
 * autorização explícita por organização e por conexão.
 *
 * ── O que este arquivo prova, e por que cada caso existe ───────────────────
 *
 *  1. A escrita LIBERADA roda no turno: chega ao servidor de fora, volta com a
 *     confirmação e entra na trilha com desfecho `ok`. Hoje (antes desta
 *     fatia) ela morria em `escrita_sem_escopo_do_turno` — é o RED do caso.
 *  2. A lista é EXPLÍCITA: `*`, `all` e `erp_*` não são expandidos. A sabotagem
 *     que aceitar curinga reprova aqui, e o nome que ele pretendia liberar
 *     continua recusado.
 *  3. Ferramenta FORA da lista = recusa NOMEADA (`escrita_nao_liberada`, com o
 *     nome da ferramenta e o da conexão), sem byte de rede e com `negado` na
 *     trilha — nunca timeout nem "erro inesperado".
 *  4. Falha do sistema EXTERNO não derruba o atendimento: a execução resolve
 *     (não lança), o modelo recebe a instrução de não confirmar sucesso e a
 *     trilha registra `erro_externo`. Fazer a falha matar o turno reprova aqui.
 *  5. Auditoria de TODA escrita: ferramenta, conexão, conversa, argumentos
 *     RESUMIDOS e desfecho. O payload inteiro não entra.
 *  6. A LEITURA e o catálogo compilado não mudam de comportamento.
 *
 * O servidor de mentira é um MCP Streamable HTTP de verdade (socket, cabeçalho,
 * corpo) — a mesma fronteira que `externo.test.ts` usa. Nenhum caso fala com a
 * internet: o stub mora em `127.0.0.1`, que o guard anti-SSRF recusa de
 * propósito, e aqui ele é injetado só para o loopback passar.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auditSpy = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));

// A chave de cifragem da instalação tem de existir ANTES de `lib/env.ts`: é ela
// que abre as colunas cifradas do registro (o caso da carga, grupo 3).
vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { McpAuthResult } from "@/lib/mcp/auth";
import { fetchDeSaida } from "@/lib/mcp/servidor-externo/chamada";
import type { FerramentaRemota } from "@/lib/mcp/servidor-externo/chamada";
import { carregarServidorMcpExterno } from "@/lib/mcp/servidor-externo/carregar";
import {
  CONEXAO_COMPARTILHADA,
  escritasLiberadasDaConexao,
  lerEscritaLiberada,
  mesclarEscritaLiberada,
  separarNomesDigitados,
} from "@/lib/mcp/servidor-externo/escrita-liberada";
import { resumirArgumentosDaEscrita } from "@/lib/mcp/servidor-externo/auditoria-da-escrita";
import { toolIdRemoto } from "@/lib/mcp/servidor-externo/ids";
import { cifrarChaveMcpExterno } from "@/lib/mcp/servidor-externo/segredo";
import type { McpContext } from "@/lib/mcp/types";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const CONTATO = "4f1c2d3e-0000-4000-8000-00000000c0a1";
const CHAVE = "chave-do-erp-4445";

const TEXTO_CONFIRMADO = "Reserva confirmada para 20/11/2026 às 15h00 (America/Sao_Paulo).";
const TOKENS_DISPONIVEIS = "20/11 15h00, 21/11 09h30, 22/11 16h00";

/** O que o stub recebeu de `tools/call`, na ordem. */
const chamadas: Array<{ nome: unknown; argumentos: Record<string, unknown> }> = [];

type Mensagem = {
  id?: unknown;
  method?: string;
  params?: { name?: unknown; arguments?: Record<string, unknown> };
};

let http: Server;
let base = "";

/** `true` = o próximo `tools/call` de agendamento não responde (ERP mudo). */
let erpMudo = false;

function responderA(mensagem: Mensagem): unknown | null {
  if (mensagem.id === undefined || mensagem.method === undefined) return null;
  const { id, method, params } = mensagem;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agenda-mcp-stub", version: "1.0.0" },
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
            // LEITURA de verdade: declara `readOnlyHint`.
            name: "erp_consultar_disponibilidade",
            description: "Consulta os horários livres na agenda.",
            inputSchema: { type: "object", properties: { data: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
          {
            // ESCRITA: não declara `readOnlyHint`.
            name: "erp_criar_agendamento",
            description: "Cria a reserva na agenda do sistema de fora.",
            inputSchema: {
              type: "object",
              properties: {
                inicio: { type: "string" },
                nome_cliente: { type: "string" },
                documento: { type: "string" },
                extras: { type: "object" },
              },
              required: ["inicio", "nome_cliente"],
            },
          },
          {
            name: "erp_cancelar_reserva",
            description: "Cancela uma reserva existente.",
            inputSchema: {
              type: "object",
              properties: { reserva_id: { type: "string" } },
              required: ["reserva_id"],
            },
          },
        ],
      },
    };
  }
  if (method === "tools/call") {
    const nome = params?.name;
    chamadas.push({ nome, argumentos: (params?.arguments ?? {}) as Record<string, unknown> });
    if (nome === "erp_consultar_disponibilidade") {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: TOKENS_DISPONIVEIS }] } };
    }
    if (nome === "erp_criar_agendamento") {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: TEXTO_CONFIRMADO }] } };
    }
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `ok: ${String(nome)}` }] } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `método desconhecido: ${method}` } };
}

beforeAll(async () => {
  http = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let corpo = "";
    req.on("data", (pedaco) => (corpo += pedaco));
    req.on("end", () => {
      let mensagens: Mensagem[] = [];
      try {
        const bruto = JSON.parse(corpo || "[]") as Mensagem | Mensagem[];
        mensagens = Array.isArray(bruto) ? bruto : [bruto];
      } catch {
        res.writeHead(400).end();
        return;
      }
      // ERP MUDO: a conexão fica aberta sem resposta. Quem corta é o timeout do
      // turno (`TIMEOUT_DA_CHAMADA_NO_TURNO_MS`), que é justamente o que o
      // caso 4 exercita. O `setTimeout` de segurança só evita socket pendurado
      // no fim da suíte.
      if (erpMudo && mensagens.some((m) => m.method === "tools/call")) {
        setTimeout(() => {
          if (!res.writableEnded) res.writeHead(503).end();
        }, 20_000);
        return;
      }
      const respostas = mensagens.map(responderA).filter((r) => r !== null);
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stub-4445" });
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
  chamadas.length = 0;
  erpMudo = false;
  auditSpy.mockClear();
});

/**
 * O guard anti-SSRF de produção com a ÚNICA exceção que o teste precisa: o
 * stub mora em `127.0.0.1`, faixa privada recusada de propósito. Allowlist,
 * `redirect: manual` e a ordem das peças continuam as de produção.
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

const FERRAMENTAS: FerramentaRemota[] = [
  { name: "erp_consultar_disponibilidade", somenteLeitura: true },
  { name: "erp_criar_agendamento" },
  { name: "erp_cancelar_reserva" },
];

const auth = {
  organizationId: ORG,
  role: "ai_operator",
  actor: { type: "ai_agent", id: "ag-1", role: "ai_operator" },
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000001",
  scopes: ["mcp:read", "mcp:write"],
} as unknown as McpAuthResult;

function bancoDeMentira() {
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: () => cadeia,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
  };
  return { from: () => cadeia } as never;
}

function contexto(): McpContext {
  const supabase = bancoDeMentira();
  return {
    organizationId: ORG,
    role: auth.role,
    actor: auth.actor,
    apiTokenId: auth.apiTokenId,
    requestId: "3f7c1e50-0000-4000-8800-000000004445",
    supabase,
  } as unknown as McpContext;
}

/** O turno de atendimento: contato identificado + a liberação desta conexão. */
function turno(opts: { liberadas: readonly string[]; escolhas: string[]; comContato?: boolean }) {
  const supabase = bancoDeMentira();
  const comContato = opts.comContato !== false;
  return pickToolsFromMcp({
    supabase,
    ctx: contexto(),
    auth,
    toolIds: opts.escolhas,
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    ...(comContato ? { contatoDoTurno: CONTATO } : {}),
    servidorMcpExterno: {
      servidor: { endpoint: base, chave: CHAVE },
      ferramentas: FERRAMENTAS,
      fetch: fetchDoStub(),
      ...(comContato ? { contato: CONTATO, cabecalhos: { "X-Deskcomm-Contato-Id": CONTATO } } : {}),
      escritasLiberadas: opts.liberadas,
    },
  });
}

type Executavel = { execute: (a: unknown) => Promise<unknown> };

function ferramenta(montadas: Record<string, unknown>, nome: string): Executavel {
  const f = montadas[nome] as Executavel | undefined;
  if (!f) throw new Error(`a ferramenta ${nome} não montou neste turno`);
  return f;
}

function ultimaAuditoriaDa(toolName: string): Record<string, unknown> {
  const eventos = auditSpy.mock.calls
    .map((c) => c[0] as { action?: string; metadata?: Record<string, unknown> })
    .filter((e) => e.action === "mcp.tool_called" && e.metadata?.tool_name === toolName);
  expect(eventos.length, `nenhuma entrada de auditoria para ${toolName}`).toBeGreaterThan(0);
  return eventos.at(-1)!.metadata as Record<string, unknown>;
}

// ─── 1. A configuração: lista explícita, dois níveis ────────────────────────

describe("a liberação de escrita é uma LISTA explícita, por organização e por conexão", () => {
  it("lê os dois níveis e cruza pelo nome da conexão", () => {
    const config = lerEscritaLiberada({
      mcp_externo_escrita: {
        organizacao: ["cancelar_reserva"],
        conexoes: { [CONEXAO_COMPARTILHADA]: ["criar_agendamento"] },
      },
    });
    expect(escritasLiberadasDaConexao(config, CONEXAO_COMPARTILHADA).sort()).toEqual([
      "cancelar_reserva",
      "criar_agendamento",
    ]);
    // Outra conexão herda SÓ o nível da organização: liberação é por conexão.
    expect(escritasLiberadasDaConexao(config, "outro-servidor")).toEqual(["cancelar_reserva"]);
    expect(config.conexoes[CONEXAO_COMPARTILHADA]).toEqual(["criar_agendamento"]);
  });

  it("CURINGA não é expandido nem guardado — `*`, `all` e `erp_*` não liberam nada", () => {
    // A sabotagem que aceitar curinga reprova AQUI: é a mesma asserção que
    // impede a lista explícita de virar uma chave booleana disfarçada.
    for (const curinga of ["*", "all", "todos", "erp_*", "erp_?", "qualquer"]) {
      const config = lerEscritaLiberada({
        mcp_externo_escrita: { organizacao: [curinga], conexoes: { [CONEXAO_COMPARTILHADA]: [curinga] } },
      });
      expect(config.organizacao, `"${curinga}" virou liberação de organização`).toEqual([]);
      expect(config.conexoes, `"${curinga}" virou liberação de conexão`).toEqual({});
      expect(escritasLiberadasDaConexao(config, CONEXAO_COMPARTILHADA)).toEqual([]);
    }
  });

  it("bolso ausente/malformado = nada liberado, e a leitura nunca lança", () => {
    for (const settings of [undefined, null, {}, { mcp_externo_escrita: "tudo" }, { mcp_externo_escrita: [] }]) {
      expect(lerEscritaLiberada(settings)).toEqual({ organizacao: [], conexoes: {} });
    }
  });

  it("nome fora do protocolo é descartado; repetido conta uma vez", () => {
    const config = lerEscritaLiberada({
      mcp_externo_escrita: { organizacao: ["criar agendamento", "a".repeat(80), "ok_tool", "ok_tool"] },
    });
    expect(config.organizacao).toEqual(["ok_tool"]);
  });

  it("grava preservando os outros bolsos do jsonb, e lista vazia APAGA o bolso", () => {
    const gravado = mesclarEscritaLiberada(
      { conversions: { meta_page_id: "111" }, mcp_externo: { endpoint: "https://erp.loja/mcp" } },
      { organizacao: ["cancelar_reserva"], conexoes: { [CONEXAO_COMPARTILHADA]: ["criar_agendamento"] } },
    );
    expect(gravado.conversions).toEqual({ meta_page_id: "111" });
    expect(gravado.mcp_externo).toEqual({ endpoint: "https://erp.loja/mcp" });
    expect(lerEscritaLiberada(gravado).conexoes[CONEXAO_COMPARTILHADA]).toEqual(["criar_agendamento"]);

    const apagado = mesclarEscritaLiberada(gravado, { organizacao: [], conexoes: {} });
    expect(apagado.mcp_externo_escrita).toBeUndefined();
    expect(lerEscritaLiberada(apagado)).toEqual({ organizacao: [], conexoes: {} });
  });

  it("a tela separa por linha/vírgula e devolve o curinga para recusar com código", () => {
    expect(separarNomesDigitados("criar_agendamento\ncancelar_reserva, remarcar")).toEqual({
      nomes: ["criar_agendamento", "cancelar_reserva", "remarcar"],
      curingas: [],
    });
    expect(separarNomesDigitados("*\ncriar_agendamento")).toEqual({
      nomes: ["criar_agendamento"],
      curingas: ["*"],
    });
  });
});

// ─── 2. Os argumentos vão RESUMIDOS para a trilha ───────────────────────────

describe("argumentos da escrita remota: forma, nunca o payload inteiro", () => {
  it("identificador passa; nome, documento e conteúdo não", () => {
    const documento = "123.456.789-00".repeat(10);
    const resumo = resumirArgumentosDaEscrita({
      inicio: "2026-11-20T15:00:00-03:00",
      evento_id: "evt_9f2c1a",
      documento,
      cpf: "123.456.789-00",
      telefone: "+55 11 98888-7777",
      nome_cliente: "Ana Beatriz de Albuquerque e Silva",
      observacao: "prefere manhã, portão azul, falar com a filha",
      extras: { cartao: "4111111111111111", cvv: "123" },
      convidados: ["a", "b", "c"],
      confirmado: true,
    });

    // Identificador de sistema: é o que a investigação usa.
    expect(resumo.inicio).toBe("2026-11-20T15:00:00-03:00");
    expect(resumo.evento_id).toBe("evt_9f2c1a");
    expect(resumo.confirmado).toBe(true);

    // Conteúdo ditado (nome, endereço, observação): só o tamanho.
    expect(resumo.nome_cliente).toEqual({ tipo: "texto", caracteres: 34 });
    expect(resumo.observacao).toEqual({ tipo: "texto", caracteres: 45 });
    expect(resumo.documento).toEqual({ tipo: "texto", caracteres: 140 });

    // Documento/telefone: forma sim, número não.
    expect(resumo.cpf).toEqual({ tipo: "numero_como_texto", digitos: 11 });
    expect(resumo.telefone).toEqual({ tipo: "numero_como_texto", digitos: 13 });

    // Objeto/array: só a forma.
    expect(resumo.extras).toEqual({ tipo: "objeto", chaves: ["cartao", "cvv"] });
    expect(resumo.convidados).toEqual({ tipo: "array", itens: 3, primeiro: "a" });

    const serializado = JSON.stringify(resumo);
    for (const proibido of ["4111111111111111", "123.456.789-00", "Beatriz", "portão azul"]) {
      expect(serializado, `"${proibido}" vazou para a trilha`).not.toContain(proibido);
    }
  });

  it("objeto aninhado profundo não vira payload: só as chaves do primeiro nível", () => {
    const resumo = resumirArgumentosDaEscrita({
      payload: { cliente: { nome: "Ana", documento: "12345678900" }, itens: [1, 2, 3] },
    });
    expect(resumo.payload).toEqual({ tipo: "objeto", chaves: ["cliente", "itens"] });
    expect(JSON.stringify(resumo)).not.toContain("12345678900");
  });
});

// ─── 3. A carga lê a configuração e amarra à conexão ────────────────────────

describe("a carga do turno resolve a liberação da conexão `compartilhado`", () => {
  function bancoCom(settings: unknown) {
    const cadeia: Record<string, unknown> = {
      select: () => cadeia,
      eq: () => cadeia,
      maybeSingle: async () => ({ data: { settings, ...cifrarChaveMcpExterno(CHAVE) }, error: null }),
    };
    return { from: () => cadeia } as never;
  }

  it("sem o bolso não há escrita liberada (fábrica)", async () => {
    const montado = await carregarServidorMcpExterno(bancoCom({ mcp_externo: { endpoint: base } }), ORG, {
      fetch: fetchDoStub(),
    });
    expect(montado?.escritasLiberadas).toEqual([]);
  });

  it("com o bolso, entrega só o que foi nomeado para ESTA conexão", async () => {
    const montado = await carregarServidorMcpExterno(
      bancoCom({
        mcp_externo: { endpoint: base },
        mcp_externo_escrita: {
          organizacao: ["cancelar_reserva"],
          conexoes: { [CONEXAO_COMPARTILHADA]: ["criar_agendamento"], "outro-servidor": ["apagar_tudo"] },
        },
      }),
      ORG,
      { fetch: fetchDoStub() },
    );
    expect(montado?.escritasLiberadas?.sort()).toEqual(["cancelar_reserva", "criar_agendamento"]);
  });
});

// ─── 4. O turno: liberada roda, fora da lista recusa nomeada ────────────────

describe("escrita liberada roda no turno e volta ao modelo", () => {
  it("a ferramenta liberada chega ao ERP e a confirmação volta ao modelo", async () => {
    // RED de hoje: sem esta fatia, esta chamada devolvia
    // `escrita_sem_escopo_do_turno` e o ERP nunca era contatado.
    const montadas = turno({
      liberadas: ["erp_criar_agendamento"],
      escolhas: [toolIdRemoto("erp_criar_agendamento", "escrita")],
    });

    const resposta = await ferramenta(montadas, "erp_criar_agendamento").execute({
      inicio: "2026-11-20T15:00:00-03:00",
      nome_cliente: "Ana",
    });

    expect(resposta).toEqual({ texto: TEXTO_CONFIRMADO });
    expect(chamadas.map((c) => c.nome)).toEqual(["erp_criar_agendamento"]);
    expect(chamadas[0]?.argumentos).toMatchObject({ inicio: "2026-11-20T15:00:00-03:00" });
  });

  it("a trilha da escrita liberada traz ferramenta, conexão, conversa, resumo e `ok`", async () => {
    const montadas = turno({
      liberadas: ["erp_criar_agendamento"],
      escolhas: [toolIdRemoto("erp_criar_agendamento", "escrita")],
    });
    await ferramenta(montadas, "erp_criar_agendamento").execute({
      inicio: "2026-11-20T15:00:00-03:00",
      nome_cliente: "Ana Beatriz de Albuquerque e Silva",
      documento: "123.456.789-00",
      extras: { cartao: "4111111111111111" },
    });

    const metadata = ultimaAuditoriaDa("erp_criar_agendamento");
    expect(metadata).toMatchObject({
      tool_name: "erp_criar_agendamento",
      conexao: CONEXAO_COMPARTILHADA,
      contact_id: CONTATO,
      success: true,
      desfecho: "ok",
    });
    // Os argumentos vão RESUMIDOS: nenhum payload inteiro na trilha.
    expect(metadata.args).toMatchObject({
      inicio: "2026-11-20T15:00:00-03:00",
      nome_cliente: { tipo: "texto", caracteres: 34 },
      documento: { tipo: "numero_como_texto", digitos: 11 },
      extras: { tipo: "objeto", chaves: ["cartao"] },
    });
    expect(JSON.stringify(metadata)).not.toContain("4111111111111111");
    expect(JSON.stringify(metadata)).not.toContain("Beatriz de Albuquerque");
  });

  it("a liberação da ORGANIZAÇÃO vale para a conexão; nome não liberado continua recusado", async () => {
    const montadas = turno({
      liberadas: escritasLiberadasDaConexao(
        lerEscritaLiberada({ mcp_externo_escrita: { organizacao: ["erp_cancelar_reserva"] } }),
        CONEXAO_COMPARTILHADA,
      ),
      escolhas: [
        toolIdRemoto("erp_cancelar_reserva", "escrita"),
        toolIdRemoto("erp_criar_agendamento", "escrita"),
      ],
    });

    expect(await ferramenta(montadas, "erp_cancelar_reserva").execute({ reserva_id: "r-1" })).toEqual({
      texto: "ok: erp_cancelar_reserva",
    });
    expect(await ferramenta(montadas, "erp_criar_agendamento").execute({ inicio: "x", nome_cliente: "Ana" })).toMatchObject({
      motivo: "escrita_nao_liberada",
    });
  });
});

describe("ferramenta fora da lista devolve recusa NOMEADA", () => {
  it("`escrita_nao_liberada` com ferramenta e conexão, sem byte de rede e `negado` na trilha", async () => {
    const montadas = turno({
      // Lista com OUTRA ferramenta: é o caso real de configuração existente e
      // incompleta — o modelo pede a que ninguém liberou.
      liberadas: ["erp_cancelar_reserva"],
      escolhas: [toolIdRemoto("erp_criar_agendamento", "escrita")],
    });

    const resposta = (await ferramenta(montadas, "erp_criar_agendamento").execute({
      inicio: "2026-11-20T15:00:00-03:00",
      nome_cliente: "Ana",
    })) as { erro?: string; motivo?: string; mensagem?: string; permitido?: boolean };

    expect(resposta).toMatchObject({ permitido: false, motivo: "escrita_nao_liberada" });
    expect(resposta.mensagem).toContain("erp_criar_agendamento");
    expect(resposta.mensagem).toContain(CONEXAO_COMPARTILHADA);
    expect(chamadas, "a chamada saiu para o ERP sem liberação").toEqual([]);

    const metadata = ultimaAuditoriaDa("erp_criar_agendamento");
    expect(metadata).toMatchObject({
      conexao: CONEXAO_COMPARTILHADA,
      contact_id: CONTATO,
      success: false,
      desfecho: "negado",
      motivo: "escrita_nao_liberada",
    });
  });

  it("CURINGA na configuração não libera nada: a mesma chamada continua recusada", async () => {
    // Sabotagem 1 (aceitar curinga) reprova aqui: `*` passaria a liberar
    // `erp_criar_agendamento` e a chamada chegaria ao ERP.
    const liberadas = escritasLiberadasDaConexao(
      lerEscritaLiberada({
        mcp_externo_escrita: { organizacao: ["*"], conexoes: { [CONEXAO_COMPARTILHADA]: ["all", "erp_*"] } },
      }),
      CONEXAO_COMPARTILHADA,
    );
    const montadas = turno({
      liberadas,
      escolhas: [toolIdRemoto("erp_criar_agendamento", "escrita")],
    });

    expect(await ferramenta(montadas, "erp_criar_agendamento").execute({ inicio: "x", nome_cliente: "Ana" })).toMatchObject({
      motivo: "escrita_nao_liberada",
    });
    expect(chamadas).toEqual([]);
  });
});

// ─── 5. A falha do terceiro não derruba o atendimento ───────────────────────

describe("falha do sistema externo não mata o turno", () => {
  it(
    "ERP mudo: a execução RESOLVE com `erro_externo`, sem confirmar a reserva, e a trilha registra",
    async () => {
      // Sabotagem 2 (deixar a falha externa subir) reprova aqui: sem o
      // `catch` que devolve texto, `execute` rejeitaria e o turno morreria.
      erpMudo = true;
      const montadas = turno({
        liberadas: ["erp_criar_agendamento"],
        escolhas: [toolIdRemoto("erp_criar_agendamento", "escrita")],
      });

      const resposta = (await ferramenta(montadas, "erp_criar_agendamento").execute({
        inicio: "2026-11-20T15:00:00-03:00",
        nome_cliente: "Ana",
      })) as { error?: string; motivo?: string; mensagem?: string };

      expect(resposta).toMatchObject({ error: "erro_externo", motivo: "erro_externo" });
      // O modelo é PROIBIDO de confirmar o que não foi confirmado.
      expect(resposta.mensagem).toMatch(/NÃO diga ao cliente/);
      expect(resposta.mensagem).toContain("erp_criar_agendamento");

      const metadata = ultimaAuditoriaDa("erp_criar_agendamento");
      expect(metadata).toMatchObject({
        conexao: CONEXAO_COMPARTILHADA,
        success: false,
        desfecho: "erro_externo",
      });
      // A trilha guarda o motivo TÉCNICO, o modelo não.
      expect(String(metadata.error).length).toBeGreaterThan(0);
    },
    30_000,
  );

  it("e o turno continua vivo: a leitura logo depois responde normalmente", async () => {
    erpMudo = true;
    const montadas = turno({
      liberadas: ["erp_criar_agendamento"],
      escolhas: [toolIdRemoto("erp_criar_agendamento", "escrita"), toolIdRemoto("erp_consultar_disponibilidade", "leitura")],
    });
    await ferramenta(montadas, "erp_criar_agendamento").execute({ inicio: "x", nome_cliente: "Ana" });

    erpMudo = false;
    expect(await ferramenta(montadas, "erp_consultar_disponibilidade").execute({ data: "2026-11-20" })).toEqual({
      texto: TOKENS_DISPONIVEIS,
    });
  }, 30_000);
});

// ─── 6. Controles: leitura e catálogo compilado não mudam ────────────────────

describe("controles", () => {
  it("a LEITURA remota continua montando em turno com contato e não leva a marca de escrita", async () => {
    const montadas = turno({
      liberadas: [],
      escolhas: [toolIdRemoto("erp_consultar_disponibilidade", "leitura")],
    });
    expect(await ferramenta(montadas, "erp_consultar_disponibilidade").execute({ data: "2026-11-20" })).toEqual({
      texto: TOKENS_DISPONIVEIS,
    });
    expect(ultimaAuditoriaDa("erp_consultar_disponibilidade")).toMatchObject({ success: true });
  });

  it("sem contato (automação), a escrita remota não é barrada pela liberação — comportamento de antes", async () => {
    const montadas = turno({
      liberadas: [],
      escolhas: [toolIdRemoto("erp_cancelar_reserva", "escrita")],
      comContato: false,
    });
    expect(await ferramenta(montadas, "erp_cancelar_reserva").execute({ reserva_id: "r-9" })).toEqual({
      texto: "ok: erp_cancelar_reserva",
    });
  });

  it("ferramenta compilada do catálogo não é tocada por esta fatia", async () => {
    const montadas = turno({ liberadas: ["erp_criar_agendamento"], escolhas: ["crm_search_products"] });
    expect(montadas.crm_search_products).toBeDefined();
  });
});
