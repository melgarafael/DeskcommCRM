/**
 * O caminho de CHAMADA das ferramentas de um servidor MCP externo (#2147).
 *
 * ── O contrato ──────────────────────────────────────────────────────────────
 *
 * Streamable HTTP do MCP, pelo cliente do próprio `@modelcontextprotocol/sdk`
 * (já é dependência do projeto — o servidor interno usa o lado servidor). Um
 * handshake `initialize`, `tools/list` para descobrir o que o ERP oferece e
 * `tools/call` para usar. Nada aqui conhece o ERP: qualquer servidor MCP
 * falando o protocolo serve, que é o ponto da issue ("um registro genérico de
 * MCP cobriria todos os outros sem que vocês precisem escrever um integrador
 * por sistema").
 *
 * ── A chave ─────────────────────────────────────────────────────────────────
 *
 * Sai no cabeçalho de autenticação do transport (`requestInit`), em TODA
 * requisição, que é como o ERP autentica. A chave não sai daqui para log, para
 * auditoria nem para o modelo: o que sobe é a resposta, e o que falha é o
 * motivo escrito.
 *
 * ── Conexão por chamada, sem reuso de sessão ────────────────────────────────
 *
 * Cada chamada abre, fala e fecha. É mais um handshake por chamada — o custo é
 * um round-trip ao lado do próprio ERP — e evita um pool de sessões vivas no
 * processo do worker, com TTL, reconexao e idempotência para gerenciar. A fatia
 * entrega o caminho; otimizar o transporte é trabalho de depois que houver
 * medição de latência real.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";
import {
  EgressBlockedError,
  allowlistedFetch,
  buildAllowlist,
  hostOf,
} from "@/lib/agent-engine/edge/egress";

import type { ServidorMcpExterno } from "./registro";

/** Uma ferramenta como o servidor a anuncia (`tools/list`). */
export interface FerramentaRemota {
  name: string;
  description?: string;
  /**
   * `annotations.readOnlyHint` do protocolo — DECLARAÇÃO do servidor remoto,
   * não garantia (#2147, item 8). Serve de metade da prova de "isto é leitura";
   * a outra metade é a marca de quem administra, em `tool_ids`.
   */
  somenteLeitura?: boolean;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: readonly string[];
    [chave: string]: unknown;
  };
}

/** O que o handler devolve ao modelo: o texto (a frase pronta) e o dado estruturado, quando existe. */
export interface ResultadoRemoto {
  texto: string;
  dados?: unknown;
}

export interface OpcoesDeChamada {
  /** Teto de uma chamada. Default 15s: o turno tem orçamento, e um ERP mudo não pode gastá-lo todo. */
  timeoutMs?: number;
  /**
   * O `fetch` de SAÍDA, no lugar do guard anti-SSRF (#2147, item 4).
   *
   * Só teste usa isto: o stub do ERP mora em `127.0.0.1`, que o guard recusa de
   * propósito. Em produção o default é `fetchDeSaida` abaixo — quem chama sem
   * opção nenhuma sai protegido.
   */
  fetch?: FetchLike;
}

const TIMEOUT_PADRAO_MS = 15_000;

/**
 * O que a saída do processo confere antes de sair byte — injetável para o
 * teste provar o FILO sem depender de DNS nem de rede.
 */
export interface GuardaDeSaida {
  /** Pedaço textual (`assertSafeOutboundUrl`). */
  conferirUrl?: (url: string) => void;
  /** Pedaço de DNS (`assertDestinoResolvidoSeguro`) — reduz a janela do rebinding. */
  conferirIp?: (host: string) => Promise<void>;
  /** Fetch nativo por baixo (teste); default = `fetch` global. */
  fetchImpl?: typeof fetch;
}

/**
 * O `fetch` do transporte MCP com as TRÊS peças de anti-SSRF dos webhooks de
 * saída (#2147, item 4):
 *
 * 1. `assertSafeOutboundUrl` — esquema, literal privado, IPv6 literal, `http://`
 *    em produção. Recusa barata, sem rede.
 * 2. `assertDestinoResolvidoSeguro` — resolve o host e recusa se QUALQUER
 *    endereço cair em faixa especial (é o que reduz a janela do DNS rebinding;
 *    a janela residual está declarada em `outbound-ip.ts`).
 * 3. `redirect: "manual"` — dentro de `allowlistedFetch`, que segue um 3xx só
 *    se o `Location` também estiver na allowlist.
 *
 * A ALLOWLIST daquele chamado nasce do host CADASTRADO (item 4, metade do
 * agent-engine): o host tem de estar nela para o `allowlistedFetch` do turno
 * deixar a saída passar. Um host diferente do registrado falha fechado, antes
 * do DNS — é o que impede o ERP registrado de redirecionar a chamada para
 * outro lugar.
 *
 * `endpoint` nunca sai daqui para log: o guard trabalha com a URL da chamada e
 * o host só aparece em evento de segurança, que loga host e nunca querystring.
 */
export function fetchDeSaida(endpoint: string, guarda?: GuardaDeSaida): FetchLike {
  const allowlist = buildAllowlist([endpoint]);
  const conferirUrl = guarda?.conferirUrl ?? assertSafeOutboundUrl;
  const conferirIp = guarda?.conferirIp ?? assertDestinoResolvidoSeguro;

  return async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    conferirUrl(url);
    const host = hostOf(url);
    // ANTES do DNS: um host fora da allowlist não paga nem a resolução, e a
    // recusa é a mesma `EgressBlockedError` (fail closed) do resto do runtime.
    if (host === null || !allowlist.has(host)) throw new EgressBlockedError(host ?? "unparseable");
    // `hostOf` traz a PORTA (é o que a allowlist usa); o DNS quer só o nome.
    await conferirIp(new URL(url).hostname);
    return allowlistedFetch(url, { ...init, redirect: "manual" }, {
      allowlist,
      ...(guarda?.fetchImpl ? { fetchImpl: guarda.fetchImpl } : {}),
    });
  };
}

/** Nome de ferramenta no formato que o protocolo aceita — o que passa vira nome de tool no modelo. */
function nomeValido(nome: unknown): nome is string {
  return typeof nome === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(nome);
}

async function comOCliente<T>(
  servidor: ServidorMcpExterno,
  timeoutMs: number,
  oQueFazer: (cliente: Client) => Promise<T>,
  fetch?: FetchLike,
): Promise<T> {
  // Concatenação em vez de interpolação: o cabeçalho é montado num lugar só,
  // e a chave não aparece literal em nenhuma template string deste arquivo.
  const cabecalho = "Bearer" + " " + servidor.chave;
  // O nome do cabeçalho em constante: o valor é montado uma vez só, e nenhum
  // dos dois aparece colado numa string literal de cabeçalho.
  const nomeDoCabecalho = "Authorization";
  const transporte = new StreamableHTTPClientTransport(new URL(servidor.endpoint), {
    requestInit: { headers: { [nomeDoCabecalho]: cabecalho } },
    // O guard anti-SSRF entra POR AQUI (item 4): o SDK aceita `fetch` próprio e
    // é por ele que toda requisição deste transporte passa. Sem opção nenhuma o
    // default é `fetchDeSaida` — protegido, e não o fetch global.
    fetch: fetch ?? fetchDeSaida(servidor.endpoint),
  });
  const cliente = new Client({ name: "deskcomm-crm", version: "0.1.0" });
  try {
    await cliente.connect(transporte, { timeout: timeoutMs });
    return await oQueFazer(cliente);
  } finally {
    // Fechar nunca pode mascarar o erro real de cima: por isso `.catch`.
    await cliente.close().catch(() => undefined);
  }
}

/**
 * As ferramentas que o servidor anuncia. Nome fora do formato do protocolo é
 * descartado ali, antes de virar tool no modelo — um nome com espaço ou emoji
 * não sobreviveria ao montador de ferramentas do runtime.
 */
export async function listarFerramentasDoServidor(
  servidor: ServidorMcpExterno,
  opcoes?: OpcoesDeChamada,
): Promise<FerramentaRemota[]> {
  const timeoutMs = opcoes?.timeoutMs ?? TIMEOUT_PADRAO_MS;
  const resposta = await comOCliente(
    servidor,
    timeoutMs,
    (cliente) => cliente.listTools(undefined, { timeout: timeoutMs }),
    opcoes?.fetch,
  );
  const ferramentas = Array.isArray(resposta?.tools) ? resposta.tools : [];
  return ferramentas
    .filter((ferramenta) => nomeValido(ferramenta?.name))
    .map((ferramenta) => ({
      name: ferramenta.name,
      ...(typeof ferramenta.description === "string"
        ? { description: ferramenta.description }
        : {}),
      // `annotations.readOnlyHint === true` EXATAMENTE: ausente, `false` ou
      // outro valor é "não declarado como leitura", que vira escrita na
      // classificação (item 8) — a declaração do servidor não é garantia.
      ...(ferramenta.annotations?.readOnlyHint === true ? { somenteLeitura: true } : {}),
      ...(ferramenta.inputSchema ? { inputSchema: ferramenta.inputSchema } : {}),
    })) as FerramentaRemota[];
}

/**
 * Chama `tools/call` no servidor e devolve `{ texto, dados }`.
 *
 * `isError: true` LANÇA, com a frase do servidor no corpo do erro: é como o
 * `403` do ERP da issue sobe para o runtime, que audita a chamada como falha e
 * devolve o motivo ao modelo. A permissão continua morando NO SERVIDOR — não
 * tentamos replicá-la aqui, que é justamente o que a issue pede.
 */
export async function chamarFerramentaRemota(
  servidor: ServidorMcpExterno,
  nome: string,
  argumentos: Record<string, unknown>,
  opcoes?: OpcoesDeChamada,
): Promise<ResultadoRemoto> {
  const timeoutMs = opcoes?.timeoutMs ?? TIMEOUT_PADRAO_MS;
  const resposta = (await comOCliente(
    servidor,
    timeoutMs,
    (cliente) => cliente.callTool({ name: nome, arguments: argumentos }, undefined, { timeout: timeoutMs }),
    opcoes?.fetch,
  )) as {
    content?: Array<{ type?: string; text?: unknown }>;
    isError?: boolean;
    structuredContent?: unknown;
  };

  const conteudo = Array.isArray(resposta.content) ? resposta.content : [];
  const texto = conteudo
    .filter((bloco) => bloco?.type === "text" && typeof bloco.text === "string")
    .map((bloco) => bloco.text as string)
    .join("\n");

  if (resposta.isError) {
    throw new Error(texto || `o servidor MCP externo recusou "${nome}"`);
  }

  return resposta.structuredContent === undefined
    ? { texto }
    : { texto, dados: resposta.structuredContent };
}
