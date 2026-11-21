// tests/unit/chat-cabecalhos.test.ts
//
// A janela do chat (`/chat/<chave>`) é embutida em site de cliente, então não pode herdar o
// `X-Frame-Options: DENY` nem o `frame-ancestors 'none'` do painel. Este teste lê a MESMA
// configuração que o Next lê no boot e confere quais cabeçalhos cada caminho recebe.
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

type Grupo = { source: string; headers: Array<{ key: string; value: string }> };

const FONTE_GLOBAL = "/((?!chat/).*)";
const FONTE_DO_CHAT = "/chat/:path*";

/**
 * Tradução MANUAL, só para as duas fontes usadas neste arquivo (o grupo sem nome com lookahead
 * e `:path*` no fim), feita à mão a partir do `source` escrito em `next.config.ts`.
 *
 * ATENÇÃO: isto NÃO prova o roteamento do Next. Quem prova se a fonte casa de verdade é o
 * build do CI, que lê a configuração pelo motor do Next. Este teste só confere a intenção
 * escrita na configuração, e pode divergir do motor sem avisar.
 */
function casa(source: string, caminho: string): boolean {
  const regex =
    source === FONTE_DO_CHAT
      ? /^\/chat(?:\/.*)?$/
      : source === FONTE_GLOBAL
        ? /^\/((?!chat\/).*)$/
        : null;
  if (!regex) return source === caminho;
  return regex.test(caminho);
}

/** Os cabeçalhos que o Next aplicaria ao caminho: a soma dos grupos que casam, o último vence. */
async function cabecalhosDe(caminho: string): Promise<Map<string, string>> {
  const grupos = ((await nextConfig.headers?.()) ?? []) as Grupo[];
  const mapa = new Map<string, string>();
  for (const grupo of grupos) {
    if (!casa(grupo.source, caminho)) continue;
    for (const h of grupo.headers) mapa.set(h.key.toLowerCase(), h.value);
  }
  return mapa;
}

describe("cabeçalhos do painel não atravessam para a janela do chat", () => {
  it("em /app/... mantém DENY e a CSP global com frame-ancestors 'none'", async () => {
    const painel = await cabecalhosDe("/app/inbox");
    expect(painel.get("x-frame-options")).toBe("DENY");
    expect(painel.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("em /chat/wck_x não recebe DENY nem frame-ancestors 'none' da configuração global", async () => {
    const janela = await cabecalhosDe("/chat/wck_x");
    expect(janela.has("x-frame-options")).toBe(false);
    // A CSP da janela vem da própria resposta da rota (`frame-ancestors` por conexão), não daqui.
    expect(janela.has("content-security-policy")).toBe(false);
  });

  it("em /chat/wck_x mantém nosniff, Referrer-Policy, HSTS e Permissions-Policy", async () => {
    const janela = await cabecalhosDe("/chat/wck_x");
    expect(janela.get("x-content-type-options")).toBe("nosniff");
    expect(janela.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(janela.get("strict-transport-security")).toMatch(/^max-age=\d{8,}/);
    expect(janela.get("permissions-policy")).toBeDefined();
  });

  it("/chat sem barra continua com o DENY global (não é rota; o source não exclui sem a barra)", async () => {
    const semBarra = await cabecalhosDe("/chat");
    expect(semBarra.get("x-frame-options")).toBe("DENY");
  });

  it("uma rota que só começa com 'chat' (sem a barra) continua recebendo o cabeçalho global", async () => {
    const outra = await cabecalhosDe("/chatbot/x");
    expect(outra.get("x-frame-options")).toBe("DENY");
  });
});
