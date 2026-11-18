// @vitest-environment node
/**
 * #4881 — a leitura de um servidor MCP **DO AGENTE** (migration 9095, inclusive
 * `oauth_por_contato`) tem de virar evidência `servidor_externo` da conferência
 * de promessa pelo MESMO caminho que a leitura do servidor compartilhado já usa:
 *
 *   1. `pickToolsFromMcp` monta a ferramenta e, se ela é `category: "read"`,
 *      ANOTA o nome no coletor `leiturasRemotas`;
 *   2. o turno (`inbound-turn.ts`, ramo `mcp.leiturasRemotas.has(name)`) envolve
 *      o `execute` e chama `evidenciasComerciais.registrarLeituraRemota` — o
 *      mesmo `EvidenciaComercial` de origem `servidor_externo`, sem um segundo
 *      vocabulário;
 *   3. `classifyPromise` recebe a evidência no pedido do revisor, e o gate
 *      `semantic_promise` deixa de vetar o fato de agenda que a issue mediu.
 *
 * A leitura que FALHA (`isError` do servidor) não vira evidência de sucesso, e
 * a ferramenta de ESCRITA nunca entra no coletor: o defeito medido era o agente
 * ser vetado ao relatar a própria agenda, não uma porta para confirmar escrita.
 *
 * O gate NÃO foi afrouxado: a mesma frase sem a evidência continua vetada, e
 * uma promessa comercial de verdade continua vetada mesmo com a evidência no
 * turno — o que muda é a evidência existir, não o critério do revisor.
 *
 * A organização é a do turno por construção: o servidor do agente é carregado
 * por `organization_id` (`carregarServidoresDoAgenteNoTurno`, em
 * `buildMcpTurnTools`, que recebe `ids.organizationId`) e a credencial é a do
 * contato do turno; nada aqui monta servidor de outra organização — a evidência
 * carrega o servidor (slug no nome) e a ferramenta, e vive só no coletor do
 * turno (a janela é o turno, não há persistência).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const seam = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
// O revisor é uma chamada de modelo; aqui o seam é o dublê que responde pelo
// MESMO contrato que `classifyPromise` lê — o que o teste prende é a evidência
// que chega até ele, não a inferência do modelo.
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({ runModelCall: seam.call }));

import { pickToolsFromMcp } from "@/lib/ai/runtime/tools";
import type { McpAuthResult } from "@/lib/mcp/auth";
import type { McpContext } from "@/lib/mcp/types";
import type { FerramentaRemota } from "@/lib/mcp/servidor-externo/chamada";
import type { ServidorDoAgenteNoTurno } from "@/lib/mcp/servidor-externo/do-agente/carregar";
import { toolIdRemoto } from "@/lib/mcp/servidor-externo/ids";
import { criarEvidenciasComerciaisDoTurno } from "@/lib/agent-engine/guardrails/promise/evidencias-comerciais";
import { classifyPromise } from "@/lib/agent-engine/guardrails/promise/semantic";
import { semanticPromiseGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import type { LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/run-model-call";
import type pg from "pg";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const CONTATO = "4f1c2d3e-0000-4000-8000-00000000c0a1";
const SERVIDOR_ID = "5e5e5e5e-0000-4000-8000-000000000488";
const LEITURA = "agenda__consultar_consultas";
const ESCRITA = "agenda__marcar_consulta";

/** A frase da issue, com o fato que a leitura devolveu. */
const CANDIDATA = "Você tem uma consulta agendada para 19/11 (quinta-feira), às 8h.";
const TEXTO_DO_SERVIDOR = "Consulta agendada para 19/11/2026 às 08:00, situação confirmada.";
const DADOS_DO_SERVIDOR = { data: "19/11/2026", horario: "08:00", situacao: "confirmada" };

const auth = {
  organizationId: ORG,
  role: "ai_operator",
  actor: { type: "ai_agent", id: "a9e1c111-0000-4000-8000-000000000001", role: "ai_operator" },
  apiTokenId: "d7ba0e68-0000-4000-8000-000000000488",
  scopes: ["mcp:read", "mcp:write"],
} as unknown as McpAuthResult;

function bancoDeMentira() {
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: () => cadeia,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  };
  return { from: () => cadeia };
}

/**
 * O servidor MCP do agente no fio: JSON-RPC sobre HTTP, respondido em processo.
 * `falha` faz o `tools/call` voltar `isError: true` — o caminho que NÃO pode
 * registrar evidência de sucesso.
 */
function fetchDoServidor(modo: "ok" | "falha"): FetchLike {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const mensagem = JSON.parse(String(init?.body ?? "{}")) as {
      id?: number | string;
      method?: string;
      params?: { protocolVersion?: string };
    };
    // Notificação (`notifications/initialized`) não tem id: nada a responder.
    if (mensagem.id === undefined) return new Response(null, { status: 202 });
    const result =
      mensagem.method === "initialize"
        ? {
            // Ecoa a versão pedida: um servidor que devolve a própria versão é
            // recusado pelo cliente do SDK.
            protocolVersion: mensagem.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "agenda-do-agente", version: "1.0.0" },
          }
        : mensagem.method === "tools/call"
          ? modo === "ok"
            ? {
                content: [{ type: "text", text: TEXTO_DO_SERVIDOR }],
                structuredContent: DADOS_DO_SERVIDOR,
              }
            : { content: [{ type: "text", text: "agenda indisponível agora" }], isError: true }
          : { tools: [] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: mensagem.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchLike;
}

function servidorDoAgente(modo: "ok" | "falha"): ServidorDoAgenteNoTurno {
  return {
    estado: "pronto",
    servidor: {
      id: SERVIDOR_ID,
      organizationId: ORG,
      agentId: "a9e1c111-0000-4000-8000-000000000001",
      nome: "Agenda do agente",
      slug: "agenda",
      endpoint: "https://agenda.example.com/mcp",
      // O modo da issue: `oauth_por_contato`, com a credencial do contato do turno.
      modo: "oauth_por_contato",
      chaveLast4: null,
      oauthClientId: null,
      temClientSecret: false,
      oauth: null,
      escoposPedidos: [],
      escritaDelegada: false,
      retencaoHoras: 24,
      ativo: true,
    },
    ferramentas: [
      // As duas metades da leitura: o servidor declara `readOnlyHint: true` e o
      // admin marcou `leitura` no `tool_ids`.
      { name: "consultar_consultas", description: "Lista as consultas", somenteLeitura: true },
      { name: "marcar_consulta", description: "Marca uma consulta" },
    ] as readonly FerramentaRemota[],
    chamavel: { endpoint: "https://agenda.example.com/mcp", chave: null },
    contato: CONTATO,
    fetch: fetchDoServidor(modo),
  } as ServidorDoAgenteNoTurno;
}

/** O turno como o engine o monta: `pickToolsFromMcp` com o coletor do turno. */
function montarTurno(modo: "ok" | "falha") {
  const supabase = bancoDeMentira();
  const leiturasRemotas = new Set<string>();
  const tools = pickToolsFromMcp({
    supabase: supabase as never,
    ctx: {
      organizationId: ORG,
      role: auth.role,
      actor: auth.actor,
      apiTokenId: auth.apiTokenId,
      requestId: "run-4881",
      supabase,
    } as unknown as McpContext,
    auth,
    toolIds: [
      toolIdRemoto("consultar_consultas", "leitura", SERVIDOR_ID),
      toolIdRemoto("marcar_consulta", "escrita", SERVIDOR_ID),
    ],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    contatoDoTurno: CONTATO,
    servidoresDoAgente: [servidorDoAgente(modo)],
    leiturasRemotas,
  });
  return { tools, leiturasRemotas };
}

type Executavel = { execute: (args: unknown) => Promise<unknown> };

/**
 * A costura do turno (`lib/agent-engine/agent/inbound-turn.ts`, ramo
 * `mcp.leiturasRemotas.has(name)`): o resultado da ferramenta só vira evidência
 * quando o nome está no coletor — a linha que o #4881 acrescentou em
 * `pickToolsFromMcp`. `inbound-turn.ts` não é importável em teste unitário
 * (módulo do worker), então a costura é reproduzida aqui na forma mínima.
 */
async function lerNoTurno(modo: "ok" | "falha") {
  const { tools, leiturasRemotas } = montarTurno(modo);
  const evidencias = criarEvidenciasComerciaisDoTurno([]);
  const ferramenta = tools[LEITURA] as unknown as Executavel;
  const resultado = await ferramenta.execute({});
  if (leiturasRemotas.has(LEITURA)) evidencias.registrarLeituraRemota(LEITURA, resultado);
  return { tools, leiturasRemotas, evidencias, resultado };
}

const db = {} as pg.Pool;
const cfg = {} as LlmEdgeConfig;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** O revisor: promessa comercial só quando a data relatada NÃO está na evidência. */
function revisorQueLeAEvidencia() {
  seam.call.mockImplementation(async (...args: unknown[]) => {
    const request = args[2] as { messages: Array<{ content: string }> };
    // Sem evidência o pedido vai como TEXTO (`buildPromiseMessage`), não JSON:
    // é o caminho de hoje, e é justamente ele que não carrega a data.
    let evidencias: unknown = [];
    try {
      evidencias = (JSON.parse(request.messages[0]!.content) as { evidencias?: unknown }).evidencias ?? [];
    } catch {
      evidencias = [];
    }
    const temOAto = JSON.stringify(evidencias).includes("19/11/2026");
    return {
      result: {
        text: JSON.stringify(
          temOAto
            ? { isPromise: false, suspectPhrase: null }
            : { isPromise: true, suspectPhrase: "19/11 (quinta-feira), às 8h" },
        ),
      },
    };
  });
}

function gateCom(classificacao: Awaited<ReturnType<typeof classifyPromise>>): GateContext {
  return { body: CANDIDATA, semanticPromise: classificacao } as unknown as GateContext;
}

describe("#4881 — a leitura do servidor MCP do agente vira evidência `servidor_externo`", () => {
  it("a ferramenta de leitura entra no coletor do turno; a de escrita não", () => {
    const { tools, leiturasRemotas } = montarTurno("ok");
    expect(Object.keys(tools).sort()).toEqual([ESCRITA, LEITURA].sort());
    expect([...leiturasRemotas]).toEqual([LEITURA]);
  });

  it("a chamada de leitura executa e registra a evidência com servidor, ferramenta e resultado", async () => {
    const { resultado, evidencias } = await lerNoTurno("ok");
    expect(resultado).toEqual({ texto: TEXTO_DO_SERVIDOR, dados: DADOS_DO_SERVIDOR });

    const lidas = evidencias.ler(CANDIDATA);
    const doServidor = lidas.filter((e) => e.origem === "servidor_externo");
    expect(doServidor).toHaveLength(1);
    // Servidor (slug `agenda`) e ferramenta no nome; a referência é a do
    // MESMO `registrarLeituraRemota` que a leitura de plataforma usa.
    expect(doServidor[0]!.referencia).toBe(`${LEITURA}:1`);
    expect(doServidor[0]!.titulo).toContain(LEITURA);
    // O fato consultado (data/horário/situação) está no conteúdo, que é o que
    // sustenta o RELATO — e a organização é a do turno, por construção.
    expect(doServidor[0]!.conteudo).toContain("19/11/2026");
    expect(doServidor[0]!.conteudo).toContain("08:00");
  });

  it("leitura que FALHA não grava evidência de sucesso", async () => {
    const { resultado, evidencias } = await lerNoTurno("falha");
    expect(resultado).toMatchObject({ error: expect.any(String) });
    expect(evidencias.ler(CANDIDATA).filter((e) => e.origem === "servidor_externo")).toEqual([]);
    expect(evidencias.materialDaOrganizacao()).toBe("[]");
  });
});

describe("#4881 — o gate semântico com a evidência do servidor do agente", () => {
  beforeEach(() => {
    seam.call.mockReset();
  });

  it("com a evidência presente, a frase de agenda da issue passa (sem veto)", async () => {
    revisorQueLeAEvidencia();
    const { evidencias } = await lerNoTurno("ok");
    const comerciais = evidencias.ler(CANDIDATA);
    expect(comerciais.some((e) => e.origem === "servidor_externo")).toBe(true);

    const classificacao = await classifyPromise(
      db,
      cfg,
      { tenantId: ORG },
      { candidate: CANDIDATA, commercialEvidence: comerciais },
      { log },
    );
    // A evidência chegou ao revisor no MESMO campo das outras origens, e a
    // instrução de que ela é DADO acompanhou o pedido.
    const request = seam.call.mock.calls[0]![2] as { system?: string; messages: Array<{ content: string }> };
    expect(JSON.parse(request.messages[0]!.content).evidencias).toEqual(
      expect.arrayContaining([expect.objectContaining({ origem: "servidor_externo" })]),
    );
    expect(request.system).toContain("é relatar um fato, não prometer");

    expect(semanticPromiseGate.evaluate(gateCom(classificacao)).pass).toBe(true);
  });

  it("SEM a evidência o mesmo fato continua vetado (o gate não foi afrouxado)", async () => {
    revisorQueLeAEvidencia();
    const evidencias = criarEvidenciasComerciaisDoTurno([]);
    const classificacao = await classifyPromise(
      db,
      cfg,
      { tenantId: ORG },
      { candidate: CANDIDATA, commercialEvidence: evidencias.ler(CANDIDATA) },
      { log },
    );
    expect(classificacao.isPromise).toBe(true);
    const veredito = semanticPromiseGate.evaluate(gateCom(classificacao));
    expect(veredito.pass).toBe(false);
    if (veredito.pass) throw new Error("devia vetar");
    expect(veredito.code).toBe("promise_semantic");
  });

  it("promessa comercial de verdade continua vetada mesmo com a leitura no turno", async () => {
    // O gate não passou a confiar na existência de evidência: ele lê o veredito
    // do revisor. Uma oferta fora do playbook segue vetada no mesmo turno.
    const { evidencias } = await lerNoTurno("ok");
    const veredito = semanticPromiseGate.evaluate(
      gateCom({
        isPromise: true,
        suspectPhrase: "te dou 20% de desconto",
        prometeuRetornoHumano: false,
        retornoSoDoAssistente: false,
      }),
    );
    expect(evidencias.ler(CANDIDATA).some((e) => e.origem === "servidor_externo")).toBe(true);
    expect(veredito.pass).toBe(false);
  });
});
