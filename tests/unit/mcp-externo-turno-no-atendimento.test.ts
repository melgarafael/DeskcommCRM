// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A LIGAÇÃO do servidor MCP externo com o TURNO QUE O ENGINE EXECUTA (#3586).
 *
 * ── Por que este arquivo, se já existem dois que cobrem o assunto ───────────
 *
 * `lib/mcp/servidor-externo/externo.test.ts` prova o caminho de CHAMADA, e
 * `tests/unit/mcp-externo-monta-pela-escolha.test.ts` prova que a escolha do
 * editor chega ao montador — os dois parando em `pickToolsFromMcp`. Mas o turno
 * de produção não chama `pickToolsFromMcp` direto: chama `buildMcpTurnTools`
 * (`inbound-turn.ts:5392` e `operator-turn.ts:486`), que resolve contato,
 * conversa, carga do servidor e só então o montador. Nada prendia essa costura:
 * apagar o `...(servidorExterno ? { servidorMcpExterno: servidorExterno } : {})`
 * de `edge/crm/mcp-tools.ts` deixaria o agente sem a ferramenta remota com a
 * suíte inteira verde — que é exatamente o sintoma relatado na issue.
 *
 * Aqui se mede pelo caminho de PRODUÇÃO, contra um servidor MCP de verdade no
 * processo (socket, cabeçalho, corpo), contando o que chega ao fio.
 *
 * ── O que cada caso prende ─────────────────────────────────────────────────
 *
 *   1. GREEN: leitura marcada + opção ligada → a ferramenta está na lista do
 *      modelo, o `tools/call` sai e a resposta entra no turno.
 *   2. OPOSTO (a): servidor fora do ar, 500 e chamada que trava → o turno
 *      CONTINUA com o catálogo compilado, sem erro cru e sem esperar o default
 *      de 15 s do cliente (o orçamento do turno é 8 s — `tempos-do-turno.ts`).
 *   3. OPOSTO (b): organização sem servidor registrado → turno idêntico ao de
 *      hoje, zero requisição.
 *   4. OPOSTO (c): servidor de OUTRA organização / contato de outra organização
 *      → nada é listado e nada é chamado.
 *
 * Roda com: pnpm vitest run tests/unit/mcp-externo-turno-no-atendimento.test.ts
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/runtime/mcp_token", () => ({
  mintEphemeralToken: async () => ({ id: "7f1c2d3e-0000-4000-8000-0000000000aa" }),
  revokeEphemeralToken: async () => undefined,
}));
// Junta de teste do guard anti-SSRF: o stub mora em `127.0.0.1`, faixa privada
// que o guard recusa de propósito, e `buildMcpTurnTools` não recebe `fetch` por
// parâmetro (é o turno de produção, não o teste). Desliga-se só a CONFERÊNCIA do
// endereço; a allowlist do host cadastrado e o `redirect: "manual"` seguem no fio.
vi.mock("@/lib/automation/outbound-url", () => ({ assertSafeOutboundUrl: () => {} }));
vi.mock("@/lib/automation/outbound-ip", () => ({ assertDestinoResolvidoSeguro: async () => {} }));

vi.hoisted(() => {
  process.env.AI_CRED_AES_KEY = "iBc1Z2gYaAH4rEHs1dHQ2dvNQ6t4OfrdE1/Y6OSvtZY=";
});

import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import { CABECALHOS_DO_CONTATO } from "@/lib/mcp/servidor-externo/chamada";
import { toolIdRemoto } from "@/lib/mcp/servidor-externo/ids";
import { cifrarChaveMcpExterno } from "@/lib/mcp/servidor-externo/segredo";
import {
  TIMEOUT_DA_CHAMADA_NO_TURNO_MS,
  TIMEOUT_DA_DESCOBERTA_NO_TURNO_MS,
} from "@/lib/mcp/servidor-externo/tempos-do-turno";

const ORG = "bcc12320-f555-4fef-8d90-38a0ac5950e0";
const OUTRA_ORG = "9e9e9e9e-0000-4000-8000-000000000002";
const CONTATO = "4f1c2d3e-0000-4000-8000-00000000c0a1";
const CONVERSA = "4f1c2d3e-0000-4000-8000-0000000c0a7a";
const CHAVE = "chave-do-estoque-123";
const FRASE = "Temos 3 Corollas 2021 a partir de R$ 119.900.";

const CATALOGO = ["crm_search_products", "crm_list_followups"];

/**
 * `normal` responde o protocolo; `500` recusa tudo; `travaNaChamada` cala no
 * `tools/call`; `travaNoHandshake` aceita a conexão e cala no `initialize`.
 */
type Modo = "normal" | "500" | "travaNaChamada" | "travaNoHandshake";

let http: Server;
let base = "";
let modo: Modo = "normal";
const requisicoes: Array<{ metodo: string | undefined; cabecalhos: IncomingHttpHeaders; corpo: string }> = [];
const chamadas: string[] = [];

function responderA(mensagem: any): any | null {
  // Notificação (`notifications/initialized`) não tem `id`: não há o que responder.
  if (mensagem?.id === undefined || mensagem?.method === undefined) return null;
  const { id, method, params } = mensagem;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        // Ecoa a versão pedida: devolver a própria faz o cliente recusar.
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "estoque-mcp-stub", version: "1.0.0" },
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
            name: "buscar_carros",
            description: "Consulta o estoque ao vivo.",
            inputSchema: {
              type: "object",
              properties: { consulta: { type: "string" } },
              required: ["consulta"],
            },
            // Declara leitura: é o que permite ao administrador marcar `leitura`.
            annotations: { readOnlyHint: true },
          },
          {
            name: "resumo_estoque",
            description: "Quantos carros por faixa de preço.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    };
  }
  if (method === "tools/call") {
    if (modo === "travaNaChamada") return null;
    chamadas.push(String(params?.name));
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: FRASE }] } };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `desconhecido: ${method}` } };
}

beforeAll(async () => {
  http = createServer((req, res) => {
    const registro = { metodo: req.method, cabecalhos: req.headers, corpo: "" };
    requisicoes.push(registro);
    if (modo === "500") {
      res.writeHead(500).end("boom");
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    req.on("data", (pedaco) => (registro.corpo += pedaco));
    req.on("end", () => {
      let mensagens: any[] = [];
      try {
        const bruto = JSON.parse(registro.corpo || "[]");
        mensagens = Array.isArray(bruto) ? bruto : [bruto];
      } catch {
        res.writeHead(400).end();
        return;
      }
      // O ERP que aceita a conexão e cala: só o `tools/call` fica sem resposta
      // (o socket aberto é o defeito medido). O resto do handshake responde —
      // notificação sem `id` leva corpo vazio, como no stub do `externo.test.ts`.
      if (modo === "travaNaChamada" && mensagens.some((m) => m?.method === "tools/call")) return;
      if (modo === "travaNoHandshake") return;
      const respostas = mensagens.map(responderA).filter((r) => r !== null);
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stub-1" });
      res.end(JSON.stringify(respostas.length === 1 ? respostas[0] : respostas));
    });
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  // `closeAllConnections`: as conexões do caso que trava ficam abertas de propósito.
  http.closeAllConnections?.();
  await new Promise<void>((ok) => http.close(() => ok()));
});

beforeEach(() => {
  modo = "normal";
  requisicoes.length = 0;
  chamadas.length = 0;
});

afterEach(() => {
  modo = "normal";
});

/**
 * O banco do turno, tabela por tabela — o mesmo contrato que `carregar.ts` lê:
 * `organizations` (settings + colunas da chave), `contacts` e `conversations`.
 *
 * A linha do servidor é devolvida só para a organização em que ele foi
 * cadastrado: é assim que a separação por organização é medida aqui (o service
 * role não tem RLS, quem separa é o filtro).
 */
function banco(op: {
  registrado?: boolean;
  registradoEm?: string;
  contatoNaOrg?: string;
  endpoint?: string;
}) {
  const organizacao = op.registradoEm ?? ORG;
  const donoDoContato = op.contatoNaOrg ?? ORG;
  const consultas: string[] = [];
  const cliente = {
    from: (tabela: string) => {
      consultas.push(tabela);
      const filtros: Record<string, unknown> = {};
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => ((filtros[coluna] = valor), cadeia),
        in: () => cadeia,
        order: () => cadeia,
        limit: () => cadeia,
        insert: () => cadeia,
        update: () => cadeia,
        delete: () => cadeia,
        maybeSingle: async () => {
          const daOrg = filtros.id === organizacao;
          if (tabela === "organizations") {
            if (op.registrado === false || !daOrg) return { data: { settings: {} }, error: null };
            return {
              data: {
                settings: { mcp_externo: { endpoint: op.endpoint ?? base } },
                ...cifrarChaveMcpExterno(CHAVE),
              },
              error: null,
            };
          }
          if (tabela === "contacts") {
            const casa =
              filtros.id === CONTATO &&
              filtros.organization_id === donoDoContato &&
              typeof filtros.organization_id === "string";
            return { data: casa ? { id: CONTATO, phone_number: "+5511987654321" } : null, error: null };
          }
          if (tabela === "conversations") {
            const casa = filtros.id === CONVERSA && filtros.contact_id === CONTATO;
            return { data: casa ? { channel: "whatsapp" } : null, error: null };
          }
          return { data: null, error: null };
        },
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
      };
      return cadeia;
    },
  };
  return { consultas, cliente: cliente as never };
}

function agentConfig(toolIds: string[]) {
  return {
    agentId: "3f7c1e50-0000-4000-8800-000000000358",
    toolIds,
    followup: null,
    pipelineIds: undefined,
    mcpExternoNoAtendimento: true,
    proposalAiDraftEnabled: false,
  } as never;
}

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

/** O turno do Conversador: contato e conversa do atendimento, orçamento cheio. */
function turno(
  op: {
    toolIds: string[];
    organizationId?: string;
    registrado?: boolean;
    registradoEm?: string;
    contatoNaOrg?: string;
    endpoint?: string;
  },
) {
  const bancoDoTurno = banco(op);
  return buildMcpTurnTools(
    { supabase: bancoDoTurno.cliente },
    {
      organizationId: op.organizationId ?? ORG,
      jobId: "6a1c2d3e-0000-4000-8000-0000000003f8",
      contactId: CONTATO,
      conversationId: CONVERSA,
    },
    agentConfig(op.toolIds),
    log,
    { readOnly: false },
  );
}

const nomes = (mcp: { tools: Record<string, unknown> } | null) => Object.keys(mcp?.tools ?? {}).sort();

/** Os POSTs que o stub recebeu — as notificações do handshake também são POST. */
const posts = () => requisicoes.filter((r) => r.metodo === "POST");

describe("o turno do engine liga e chama o servidor MCP externo (#3586)", () => {
  it("leitura marcada + opção ligada: a ferramenta entra no turno e o `tools/call` sai com a identidade do contato", async () => {
    const mcp = await turno({
      toolIds: [...CATALOGO, toolIdRemoto("buscar_carros", "leitura")],
    });

    // 1. O modelo VÊ a ferramenta, ao lado das compiladas (remota soma).
    expect(nomes(mcp)).toEqual([...CATALOGO, "buscar_carros"].sort());

    // 2. O modelo chama → `tools/call` no fio, uma vez, com o argumento dele.
    const ferramenta = (mcp as any).tools.buscar_carros as {
      execute: (a: unknown) => Promise<unknown>;
    };
    const resposta = await ferramenta.execute({ consulta: "corolla" });

    expect(chamadas).toEqual(["buscar_carros"]);
    expect(resposta).toEqual({ texto: FRASE });

    // 3. A resposta volta como observação do turno, e a requisição levou a
    //    identidade do contato lida do banco + a chave do cadastro.
    const daChamada = posts().at(-1)!;
    expect(daChamada.corpo).toContain('"buscar_carros"');
    expect(daChamada.cabecalhos[CABECALHOS_DO_CONTATO.id.toLowerCase()]).toBe(CONTATO);
    expect(daChamada.cabecalhos.authorization).toBe(`Bearer ${CHAVE}`);
  });

  it("a marca de ESCRITA não vira leitura: o turno lista, mas não chama o ERP (regra de escopo do turno)", async () => {
    // Comportamento de hoje, congelado de propósito: é o que os pedidos do fio
    // da #3586 (escrita marcada pelo administrador durante a conversa) mudam, e
    // mudar isso é decisão do dono. Enquanto não for, o `tools/call` é ZERO.
    const mcp = await turno({
      toolIds: [...CATALOGO, toolIdRemoto("resumo_estoque", "escrita")],
    });
    const ferramenta = (mcp as any).tools.resumo_estoque as {
      execute: (a: unknown) => Promise<unknown>;
    };
    const resposta = (await ferramenta.execute({})) as { permitido?: boolean; motivo?: string };

    expect(chamadas).toEqual([]);
    expect(resposta.permitido).toBe(false);
    expect(resposta.motivo).toBeTruthy();
  });
});

describe("lado oposto: o terceiro fora do ar não derruba nem trava o turno", () => {
  it("endpoint que recusa conexão: turno com o catálogo de hoje, nada remoto, zero requisição", async () => {
    const mcp = await turno({
      toolIds: [...CATALOGO, toolIdRemoto("buscar_carros", "leitura")],
      // Porta 1 do loopback: conexão recusada na hora.
      endpoint: "http://127.0.0.1:1/mcp",
    });

    expect(nomes(mcp)).toEqual([...CATALOGO].sort());
    expect(chamadas).toEqual([]);
  });

  it("servidor que responde 500: turno segue igual, sem erro cru e sem ferramenta fantasma", async () => {
    modo = "500";
    const mcp = await turno({
      toolIds: [...CATALOGO, toolIdRemoto("buscar_carros", "leitura")],
    });

    expect(nomes(mcp)).toEqual([...CATALOGO].sort());
    expect(chamadas).toEqual([]);
  });

  it(
    "servidor que aceita a conexão e trava no HANDSHAKE: a descoberta corta em ~8 s e o turno nasce sem remota",
    { timeout: 30_000 },
    async () => {
      modo = "travaNoHandshake";
      const comeco = Date.now();
      const mcp = await turno({
        toolIds: [...CATALOGO, toolIdRemoto("buscar_carros", "leitura")],
      });
      const gasto = Date.now() - comeco;

      // `null` ou só o catálogo: sem descoberta não há ferramenta remota — e o
      // turno segue, porque a carga devolve `null` em vez de lançar.
      expect(mcp === null || nomes(mcp).every((n) => CATALOGO.includes(n))).toBe(true);
      expect(gasto).toBeLessThan(TIMEOUT_DA_DESCOBERTA_NO_TURNO_MS + 4_000);
    },
  );

  it(
    "servidor que ACEITA a conexão e trava na chamada: o turno corta em ~8 s e continua",
    { timeout: 30_000 },
    async () => {
      modo = "travaNaChamada";
      const mcp = await turno({
        toolIds: [...CATALOGO, toolIdRemoto("buscar_carros", "leitura")],
      });
      expect(nomes(mcp)).toContain("buscar_carros");

      const ferramenta = (mcp as any).tools.buscar_carros as {
        execute: (a: unknown) => Promise<unknown>;
      };
      const comeco = Date.now();
      // A promessa RESOLVE (o turno recebe texto/erro), não rejeita: uma remota
      // que falha não pode matar o turno (`wrapMcpTool`).
      const resposta = await ferramenta.execute({ consulta: "corolla" });
      const gasto = Date.now() - comeco;

      expect(chamadas, "o stub travado não deveria registrar chamada").toEqual([]);
      expect(resposta).toBeTruthy();
      // O orçamento do turno: 8 s + folga de agendamento. O default do cliente
      // seria 15 s por passo (connect + call) e este caso estouraria o teto.
      expect(gasto).toBeLessThan(TIMEOUT_DA_CHAMADA_NO_TURNO_MS + 4_000);
    },
  );
});

describe("lado oposto: organização sem servidor e servidor de outra organização", () => {
  it("organização sem servidor registrado: turno idêntico ao de hoje e zero requisição", async () => {
    const semServidor = await turno({
      toolIds: [...CATALOGO, toolIdRemoto("buscar_carros", "leitura")],
      registrado: false,
    });
    const soCatalogo = await turno({ toolIds: [...CATALOGO], registrado: false });

    expect(nomes(semServidor)).toEqual(nomes(soCatalogo));
    expect(requisicoes, "abriu rede sem servidor registrado").toEqual([]);
  });

  it("servidor cadastrado em OUTRA organização: não é listado nem chamado no turno desta", async () => {
    const mcp = await turno({
      toolIds: [...CATALOGO, toolIdRemoto("buscar_carros", "leitura")],
      // A linha do servidor pertence a OUTRA_ORG; o turno é da ORG.
      registradoEm: OUTRA_ORG,
    });

    expect(nomes(mcp)).toEqual([...CATALOGO].sort());
    expect(requisicoes, "o turno falou com o servidor de outra organização").toEqual([]);
  });

  it("contato de OUTRA organização: o servidor não carrega e nada é chamado (falha fechada)", async () => {
    const mcp = await turno({
      toolIds: [...CATALOGO, toolIdRemoto("buscar_carros", "leitura")],
      contatoNaOrg: OUTRA_ORG,
    });

    expect(nomes(mcp)).toEqual([...CATALOGO].sort());
    expect(requisicoes).toEqual([]);
    expect(chamadas).toEqual([]);
  });
});
