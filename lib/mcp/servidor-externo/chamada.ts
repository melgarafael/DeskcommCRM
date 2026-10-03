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
 * Sai como `Authorization: Bearer <chave>` em TODA requisição (`requestInit` do
 * transport), que é como o ERP autentica. Ela não sai daqui para log, para
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

import type { ServidorMcpExterno } from "./registro";

/** Uma ferramenta como o servidor a anuncia (`tools/list`). */
export interface FerramentaRemota {
  name: string;
  description?: string;
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
}

const TIMEOUT_PADRAO_MS = 15_000;

/** Nome de ferramenta no formato que o protocolo aceita — o que passa vira nome de tool no modelo. */
function nomeValido(nome: unknown): nome is string {
  return typeof nome === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(nome);
}

async function comOCliente<T>(
  servidor: ServidorMcpExterno,
  timeoutMs: number,
  oQueFazer: (cliente: Client) => Promise<T>,
): Promise<T> {
  const transporte = new StreamableHTTPClientTransport(new URL(servidor.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${servidor.chave}` } },
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
  const resposta = await comOCliente(servidor, timeoutMs, (cliente) =>
    cliente.listTools(undefined, { timeout: timeoutMs }),
  );
  const ferramentas = Array.isArray(resposta?.tools) ? resposta.tools : [];
  return ferramentas
    .filter((ferramenta) => nomeValido(ferramenta?.name))
    .map((ferramenta) => ({
      name: ferramenta.name,
      ...(typeof ferramenta.description === "string"
        ? { description: ferramenta.description }
        : {}),
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
  const resposta = (await comOCliente(servidor, timeoutMs, (cliente) =>
    cliente.callTool({ name: nome, arguments: argumentos }, undefined, { timeout: timeoutMs }),
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
