/**
 * Fornecedor sintético: socket HTTP + protocolo/SDK MCP reais. Não é ERP real,
 * autenticação da rota do app nem modelo público. A exceção de loopback vive
 * SOMENTE nesta junta de teste; o fetch/antiSSRF produtivo permanece intacto.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchDeSaida } from "@/lib/mcp/servidor-externo/chamada";
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";

export interface FerramentaMcpSintetica {
  name: string;
  leitura?: boolean;
}
export interface ChamadaMcpObservada {
  metodo: string;
  ferramenta?: string;
  argumentos?: unknown;
  autenticada: boolean;
  contato?: string;
}

export async function abrirMcpDaPrevia(ferramentas: FerramentaMcpSintetica[]) {
  const chave = "credencial-sintetica-do-fornecedor-mcp";
  const chamadas: ChamadaMcpObservada[] = [];
  let recusar = false;
  const servidor = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(req.method === "DELETE" ? 200 : 405).end(); return; }
    const partes: Buffer[] = [];
    try {
      for await (const parte of req) partes.push(Buffer.from(parte));
      const mensagem = JSON.parse(Buffer.concat(partes).toString()) as {
        id?: number | string; method?: string;
        params?: { protocolVersion?: string; name?: string; arguments?: unknown };
      };
      const observada: ChamadaMcpObservada = {
        metodo: mensagem.method ?? "",
        autenticada: req.headers.authorization === `Bearer ${chave}`,
        ...(typeof req.headers["x-deskcomm-contato-id"] === "string"
          ? { contato: req.headers["x-deskcomm-contato-id"] } : {}),
      };
      if (mensagem.method === "tools/call") {
        observada.ferramenta = mensagem.params?.name;
        observada.argumentos = mensagem.params?.arguments;
      }
      chamadas.push(observada);
      if (!observada.autenticada) { res.writeHead(401).end(); return; }
      if (mensagem.id === undefined) { res.writeHead(202).end(); return; }
      const resultado = mensagem.method === "initialize"
        ? { protocolVersion: mensagem.params?.protocolVersion, capabilities: { tools: {} },
            serverInfo: { name: "fornecedor-sintetico", version: "1" } }
        : mensagem.method === "tools/list"
          ? { tools: ferramentas.map((f) => ({ name: f.name,
              inputSchema: { type: "object", properties: { consulta: { type: "string" } } },
              ...(f.leitura === undefined ? {} : { annotations: { readOnlyHint: f.leitura } }),
            })) }
          : mensagem.method === "tools/call"
            ? { content: [{ type: "text", text: recusar ? "Consulta sintética recusada." : "O catálogo sintético está disponível." }],
                ...(recusar ? { isError: true } : {}) }
            : null;
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sessao-sintetica" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: mensagem.id, result: resultado }));
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  servidor.requestTimeout = 3_000;
  servidor.headersTimeout = 3_000;
  servidor.setTimeout(3_000, (socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      const controle = new AbortController();
      const timer = setTimeout(() => { controle.abort(); reject(new Error("mcp_sintetico_listen_timeout")); }, 5_000);
      const falhou = (erro: Error) => { clearTimeout(timer); reject(erro); };
      servidor.once("error", falhou);
      servidor.listen({ host: "127.0.0.1", port: 0, signal: controle.signal }, () => {
        clearTimeout(timer); servidor.removeListener("error", falhou); resolve();
      });
    });
  } catch (erro) { servidor.closeAllConnections(); servidor.close(); throw erro; }
  const endpoint = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/mcp`;
  const fetchDoFornecedor = fetchDeSaida(endpoint, {
    conferirUrl: (alvo) => { if (alvo !== endpoint) assertSafeOutboundUrl(alvo); },
    conferirIp: async (host) => { if (host !== "127.0.0.1") await assertDestinoResolvidoSeguro(host); },
  });
  return {
    endpoint, chave, chamadas, fetch: fetchDoFornecedor,
    recusar: () => { recusar = true; },
    async fechar() {
      if (!servidor.listening) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("mcp_sintetico_cleanup_timeout")), 3_000);
        servidor.closeAllConnections();
        servidor.close((erro) => { clearTimeout(timer); if (erro) reject(erro); else resolve(); });
      });
    },
  };
}
