import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/v1/health — o check do banco deixa de dizer `ok` quando quem responde
 * no lugar do PostgREST é a tela de login.
 *
 * ## A classe de defeito
 *
 * "O endereço respondeu" não é "o BANCO respondeu". Numa instalação em que o
 * endereço configurado para o Supabase cai num proxy, o ping do banco levava um
 * `307` para `/login`. O `fetch`, sozinho, SEGUE o redirect: chegava na tela de
 * login, recebia o `200` do HTML dela e o check declarava o banco de pé. O
 * `/health` dizia `ok` com o PostgREST inalcançável — e `wait_app_healthy`
 * (é ele que decide se uma atualização é mantida ou revertida) lia esse `ok`.
 *
 * ## O que este arquivo vigia
 *
 * 1. O ping do banco NÃO segue redirect — é o que faz o `3xx` chegar cru.
 * 2. O `307` vira `down`, com o destino do `Location` no detalhe.
 * 3. Um `200` que NÃO é JSON do PostgREST (a tela de login) também vira `down`.
 * 4. O `401/403` do Supabase de verdade continua `ok`: ali quem respondeu foi o
 *    banco, recusando a credencial — e um `down` aqui acusaria um banco de pé.
 *
 * ## O que o detalhe esconde, e por quê
 *
 * A rota é PÚBLICA: `target` e o texto do `error` já são redigidos para quem não
 * tem o segredo interno (ver `route.test.ts`). O destino do `Location` é o mesmo
 * tipo de endereço, então ele sai com `?verbose=1` mais o segredo — e é assim
 * que o caso 2 o lê. Redigir não pode virar apagar, e por isso o veredito
 * (`down`, HTTP 503) continua visível para o monitor anônimo.
 */

const URL_DO_PROJETO = "https://projeto-do-cliente.supabase.co";
const TELA_DE_LOGIN = "https://crm.exemplo.com.br/login";
const SEGREDO = "segredo-interno-de-teste-com-tamanho-suficiente";
/** O `content-type` que a tela de login serve — e que o PostgREST nunca serve. */
const HTML_DA_TELA_DE_LOGIN = "<!DOCTYPE html><html><body>Entrar</body></html>";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: URL_DO_PROJETO,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "chave-anon-de-teste",
    SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
    UPSTASH_REDIS_REST_URL: "https://redis-de-teste.exemplo",
    UPSTASH_REDIS_REST_TOKEN: "token-de-teste",
    INTERNAL_CRON_SECRET: "segredo-interno-de-teste-com-tamanho-suficiente",
    INTERNAL_SECRET: "",
  },
}));

function pedido(query = "", autenticado = false): NextRequest {
  return new NextRequest(`https://crm.exemplo.com.br/api/v1/health${query}`, {
    headers: autenticado ? { authorization: `Bearer ${SEGREDO}` } : {},
  });
}

/**
 * Dublê do `fetch`: o endereço do BANCO responde o que o caso mandar, e os
 * demais serviços respondem `200` JSON (senão eles derrubariam o veredito geral
 * e o caso não provaria nada do banco).
 *
 * O dublê imita a semântica REAL do `fetch`: redirect é SEGUIDO por padrão, e um
 * `3xx` só chega cru quando a chamada pede `redirect: "manual"` — e é aí que ele
 * entrega o `200` da tela de login, exatamente como o defeito nasceu. Sem essa
 * fidelidade o dublê seria mais generoso que o `fetch`: ele devolveria o `3xx`
 * para quem não pediu `manual`, e o teste passaria a provar menos que a
 * realidade (o `307` chegaria cru de graça para o código sem o conserto).
 */
function espiao(respostaDoBanco: () => Response): Parameters<typeof fetch>[] {
  const chamadas: Parameters<typeof fetch>[] = [];
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
    chamadas.push(args);
    const alvo = typeof args[0] === "string" ? args[0] : String(args[0]);
    if (!alvo.startsWith(URL_DO_PROJETO)) {
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    const resposta = respostaDoBanco();
    const ehRedirecionamento = resposta.status >= 300 && resposta.status < 400;
    if (ehRedirecionamento && args[1]?.redirect !== "manual") {
      return Promise.resolve(
        new Response(HTML_DA_TELA_DE_LOGIN, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
    return Promise.resolve(resposta);
  });
  return chamadas;
}

/** Cabeçalhos com que o ping do Supabase saiu, ou null se ele não saiu. */
function cabecalhosDoPingDoBanco(chamadas: Parameters<typeof fetch>[]): Headers | null {
  for (const [entrada, init] of chamadas) {
    const alvo = typeof entrada === "string" ? entrada : String(entrada);
    if (alvo.startsWith(URL_DO_PROJETO)) return new Headers(init?.headers);
  }
  return null;
}

/** O `init` com que o ping do Supabase saiu, ou null se ele não saiu. */
function opcoesDoPingDoBanco(chamadas: Parameters<typeof fetch>[]): RequestInit | null {
  for (const [entrada, init] of chamadas) {
    const alvo = typeof entrada === "string" ? entrada : String(entrada);
    if (alvo.startsWith(URL_DO_PROJETO)) return init ?? {};
  }
  return null;
}

/** O corpo de um `GET /health`, já com o `status` HTTP e o `data` desempacotados. */
async function consultarSaude(query = "", autenticado = false) {
  const { GET } = await import("./route");
  const resposta = await GET(pedido(query, autenticado));
  const corpo = await resposta.json();
  return { http: resposta.status, data: corpo.data as {
    status: string;
    checks: { supabase: { status: string; error?: string; reason?: string } };
  } };
}

describe("GET /api/v1/health — o banco não é 'quem respondeu', é o PostgREST", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("não segue redirect: o ping do banco sai com redirect manual", async () => {
    const chamadas = espiao(
      () => new Response(null, { status: 307, headers: { location: TELA_DE_LOGIN } }),
    );

    await consultarSaude();

    const opcoes = opcoesDoPingDoBanco(chamadas);
    expect(opcoes, "o ping do Supabase não chegou a sair").not.toBeNull();
    // Sem esta linha o `fetch` SEGUE o redirect até a tela de login e o `200`
    // do HTML dela é lido como banco de pé. É a asserção que fica vermelha
    // quando o `redirect: "manual"` some.
    expect(opcoes?.redirect).toBe("manual");
    // O resto do ping não pode ter regredido no caminho: o schema continua indo.
    expect(cabecalhosDoPingDoBanco(chamadas)?.get("Accept-Profile")).toBe("public");
  });

  it("um 307 para a tela de login vira down, unhealthy e HTTP 503", async () => {
    espiao(() => new Response(null, { status: 307, headers: { location: TELA_DE_LOGIN } }));

    const { http, data } = await consultarSaude();

    // O veredito que o monitor externo lê, sem segredo nenhum.
    expect(data.checks.supabase.status).toBe("down");
    expect(data.status).toBe("unhealthy");
    expect(http).toBe(503);
  });

  it("carrega o destino do Location no detalhe — e o redige de quem não tem o segredo", async () => {
    espiao(() => new Response(null, { status: 307, headers: { location: TELA_DE_LOGIN } }));

    const anonimo = await consultarSaude();
    const comSegredo = await consultarSaude("?verbose=1", true);

    // Quem opera precisa saber PARA ONDE fomos mandados: é o que aponta o proxy
    // no lugar do PostgREST.
    expect(comSegredo.data.checks.supabase.error).toContain(TELA_DE_LOGIN);
    expect(comSegredo.data.checks.supabase.reason).toBe("resposta_inesperada");
    // A rota é pública: o endereço não sai para quem só passa na frente. O
    // veredito sai — é o que o caso acima prova.
    expect(anonimo.data.checks.supabase.error).not.toContain(TELA_DE_LOGIN);
    expect(anonimo.data.checks.supabase.status).toBe("down");
  });

  it("um 200 com content-type text/html NÃO conta como banco de pé", async () => {
    // O `200` da tela de login: sem o conserto, era este corpo que virava `ok`.
    espiao(
      () =>
        new Response(HTML_DA_TELA_DE_LOGIN, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    const { http, data } = await consultarSaude();

    expect(data.checks.supabase.status).toBe("down");
    expect(data.status).toBe("unhealthy");
    expect(http).toBe(503);
  });

  it("um 200 sem content-type e com corpo HTML também não conta", async () => {
    espiao(() => new Response(HTML_DA_TELA_DE_LOGIN, { status: 200 }));

    const { data } = await consultarSaude();

    expect(data.checks.supabase.status).toBe("down");
  });

  it.each([
    ["com content-type de JSON", "application/json"],
    ["sem content-type nenhum (o carimbo do `fetch` do Node é text/plain)", undefined],
  ])("um 200 que é JSON do PostgREST continua ok %s", async (_nome, contentType) => {
    espiao(
      () =>
        new Response("[]", {
          status: 200,
          ...(contentType ? { headers: { "content-type": contentType } } : {}),
        }),
    );

    const { http, data } = await consultarSaude();

    // A régua não pode virar "todo 200 é suspeito": uma lista vazia por RLS é o
    // banco de pé respondendo, e é o que a sonda pede. O caso sem cabeçalho é o
    // que a régua pelo `content-type` reprovaria sem motivo.
    expect(data.checks.supabase.status).toBe("ok");
    expect(http).toBe(200);
  });

  it.each([401, 403])("o %i do Supabase de verdade continua ok", async (status) => {
    espiao(() => new Response("", { status }));

    const { data } = await consultarSaude();

    // Chegamos ao PostgREST e fomos barrados pela RLS do anon: o banco está de
    // pé. Declarar `down` aqui seria o falso alarme que o arquivo combate.
    expect(data.checks.supabase.status).toBe("ok");
  });
});
