// @vitest-environment node
/**
 * #4326, item 1 — o proxy deixa de ir ao GoTrue em TODA requisição.
 *
 * O `proxy.ts` chamava `supabase.auth.getUser()` para todo caminho não público:
 * uma ida a `/auth/v1/user` por aba, por fetch e por navegação, mesmo com a
 * sessão intacta. O #3696 pôs um cache curto de 30 s na cadeia do handler
 * (`lib/auth/server.ts`), mas o proxy roda ANTES dele e ficou de fora.
 *
 * Aqui o GoTrue é dublado no `globalThis.fetch` — é o mesmo ponto que
 * `fetchDoServidor` lê em tempo de chamada (`lib/supabase/fetch-do-servidor.ts`),
 * então a contagem é a ida real que o SDK faria.
 *
 * O que estes casos fixam:
 *  - duas requisições dentro da janela = UMA ida ao `/auth/v1/user`;
 *  - passada a janela, volta a validar (o teto é a janela, não a sessão);
 *  - sessão revogada não passa DEPOIS da janela (e, dentro dela, o pior caso
 *    está declarado no PR: a identidade em cache ainda abre o portão);
 *  - sem cookie de sessão (logout já feito) o cache NÃO serve resposta: a
 *    requisição vai para o caminho direto e termina em `/login`;
 *  - decisão de AUTORIZAÇÃO continua por requisição: o RPC de platform admin é
 *    chamado nas duas, mesmo com a identidade vinda do cache.
 */
import { NextRequest } from "next/server";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.exemplo",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-de-teste",
    NEXT_PUBLIC_APP_URL: "https://crm.exemplo",
  },
}));

import {
  TTL_CURTO_MS,
  esquecerTudo,
  invalidarSessao,
  invalidarUsuario,
  sessaoDosCookies,
} from "@/lib/auth/cache-curto";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const relogio = { agora: Date.UTC(2026, 10, 11, 12, 0, 0) };
const EXPIRACAO_DO_TOKEN_S = Math.floor(relogio.agora / 1000) + 3600;

const estado = {
  /** idas a `/auth/v1/user` — a conta que o item 1 da #4326 quer derrubar. */
  usuarios: 0,
  /** chamadas a `fn_is_platform_admin` — autorização, que NÃO pode ser cacheada. */
  admins: 0,
  /** idas a `/auth/v1/token` — a renovação que o auth-js faz dentro da margem. */
  renovacoes: 0,
  goTrue: "ok" as "ok" | "revogado",
};

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function tokenDeAcesso(exp: number): string {
  return `${b64({ alg: "HS256" })}.${b64({ sub: USER_ID, exp })}.assinatura`;
}

function cookieDeSessao(): { name: string; value: string } {
  const token = tokenDeAcesso(EXPIRACAO_DO_TOKEN_S);
  // O formato que o `@supabase/ssr` grava (`base64-` + base64url do JSON) e o
  // que o `_isValidSession` do auth-js exige: access_token, refresh_token e
  // expires_at — sem qualquer um dos três, o cliente trata como "sem sessão".
  return {
    name: "sb-deskcomm-auth",
    value: `base64-${b64({
      access_token: token,
      refresh_token: "refresh-de-teste",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: EXPIRACAO_DO_TOKEN_S,
      user: { id: USER_ID, email: "membro@example.com", user_metadata: {}, app_metadata: {} },
    })}`,
  };
}

/** O GoTrue e o PostgREST dublados no único ponto que o SDK enxerga. */
function dublarSupabase() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (entrada) => {
    const url =
      typeof entrada === "string"
        ? entrada
        : entrada instanceof URL
          ? entrada.href
          : (entrada as Request).url;
    if (url.includes("/auth/v1/user")) {
      estado.usuarios += 1;
      if (estado.goTrue === "revogado") {
        return json({ code: 401, msg: "invalid JWT: session revoked" }, 401);
      }
      return json({ id: USER_ID, email: "membro@example.com", user_metadata: {}, app_metadata: {} });
    }
    if (url.includes("/auth/v1/token")) {
      estado.renovacoes += 1;
      return json({
        access_token: tokenDeAcesso(EXPIRACAO_DO_TOKEN_S + 3600),
        refresh_token: "refresh-renovado",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: EXPIRACAO_DO_TOKEN_S + 3600,
        user: { id: USER_ID, email: "membro@example.com", user_metadata: {}, app_metadata: {} },
      });
    }
    if (url.includes("/rpc/fn_is_platform_admin")) {
      estado.admins += 1;
      return json(true);
    }
    return json({ code: 404, msg: `sem dublê para ${url}` }, 404);
  });
}

async function pedir(caminho: string, cookie: { name: string; value: string } | null = cookieDeSessao()) {
  const { proxy } = await import("@/proxy");
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = `${cookie.name}=${cookie.value}`;
  return proxy(new NextRequest(`https://crm.exemplo${caminho}`, { headers }));
}

beforeEach(() => {
  estado.usuarios = 0;
  estado.admins = 0;
  estado.renovacoes = 0;
  estado.goTrue = "ok";
  relogio.agora = Date.UTC(2026, 10, 11, 12, 0, 0);
  vi.spyOn(Date, "now").mockImplementation(() => relogio.agora);
  esquecerTudo();
  dublarSupabase();
});

afterEach(() => {
  vi.restoreAllMocks();
  esquecerTudo();
});

describe("#4326 item 1 — o proxy valida a identidade uma vez por janela", () => {
  it("duas requisições dentro da janela fazem UMA ida ao /auth/v1/user", async () => {
    const primeira = await pedir("/app/inbox");
    const segunda = await pedir("/app/inbox");

    expect(primeira.headers.get("x-middleware-next")).toBe("1");
    expect(segunda.headers.get("x-middleware-next")).toBe("1");
    expect(estado.usuarios).toBe(1);
  });

  it("para /api/ a segunda requisição da janela também não volta ao GoTrue", async () => {
    // O poll da casca (30 s) é o caso mais caro do produto — e não é caminho público.
    const primeira = await pedir("/api/v1/conversations/counts");
    const segunda = await pedir("/api/v1/conversations/counts");

    expect(primeira.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(estado.usuarios).toBe(1);
  });

  it("uma navegação inteira — documento + 8 chamadas da casca — faz UMA ida ao GoTrue", async () => {
    for (let i = 0; i < 9; i += 1) {
      await pedir("/api/v1/conversations/counts");
    }
    expect(estado.usuarios).toBe(1);
  });

  it("passada a janela, o proxy volta a validar", async () => {
    await pedir("/app/inbox");
    await pedir("/app/inbox");
    expect(estado.usuarios).toBe(1);

    relogio.agora += TTL_CURTO_MS + 1;
    await pedir("/app/inbox");
    expect(estado.usuarios).toBe(2);
  });

  it("sessão revogada não passa DEPOIS da janela", async () => {
    await pedir("/app/inbox");
    expect(estado.usuarios).toBe(1);

    // Revogação no GoTrue (sair de todos os aparelhos, usuário desativado…).
    estado.goTrue = "revogado";

    // Dentro da janela: é o risco declarado no PR — a identidade em cache
    // ainda abre o portão, e o handler lê a MESMA entrada. Quem fecha antes
    // do TTL é a invalidação (`invalidarSessao`/`invalidarUsuario`), não o banco.
    const dentroDaJanela = await pedir("/app/inbox");
    expect(dentroDaJanela.headers.get("x-middleware-next")).toBe("1");
    expect(estado.usuarios).toBe(1);

    // Passada a janela, o proxy volta ao GoTrue e a sessão revogada cai.
    relogio.agora += TTL_CURTO_MS + 1;
    const depoisDaJanela = await pedir("/app/inbox");
    expect(estado.usuarios).toBe(2);
    expect(depoisDaJanela.status).toBe(307);
    expect(depoisDaJanela.headers.get("location")).toContain("/login");
  });

  it("logout: sem cookie de sessão o cache não serve nada — a requisição cai em /login", async () => {
    await pedir("/app/inbox");
    expect(estado.usuarios).toBe(1);

    // O `signOut` apaga os cookies de sessão; o cache ainda tem a identidade.
    const depoisDoLogout = await pedir("/app/inbox", null);

    expect(depoisDoLogout.status).toBe(307);
    expect(depoisDoLogout.headers.get("location")).toContain("/login");
    // Sem cookie não há chave de cache: nada foi reaproveitado.
    expect(estado.usuarios).toBe(1);
  });

  it("logout: o invalidarSessao da saída derruba a entrada mesmo com o cookie reapresentado", async () => {
    const cookie = cookieDeSessao();
    await pedir("/app/inbox", cookie);
    expect(estado.usuarios).toBe(1);

    const sessao = sessaoDosCookies([cookie]);
    expect(sessao).not.toBeNull();
    invalidarSessao(sessao!.chave);

    await pedir("/app/inbox", cookie);
    expect(estado.usuarios).toBe(2);
  });

  it("invalidarUsuario (sair de todos os aparelhos, MFA novo) derruba a entrada que o proxy escreveu", async () => {
    // O proxy roda ANTES do handler: numa sessão nova é ele quem grava a entrada
    // `sessao:<hash>`, e o handler só a lê. A etiqueta do usuário tem de estar
    // nela, senão a revogação por identidade espera o TTL.
    await pedir("/app/inbox");
    expect(estado.usuarios).toBe(1);

    invalidarUsuario(USER_ID);

    await pedir("/app/inbox");
    expect(estado.usuarios).toBe(2);
  });

  it("dentro da margem de renovação do auth-js o proxy não serve o cache: volta ao GoTrue e renova", async () => {
    // O `getUser()` do proxy é quem renova a sessão quando faltam menos de
    // `EXPIRY_MARGIN_MS` (90 s) para o `exp`, e só ele devolve o cookie novo
    // ao navegador. Uma entrada gravada ANTES da margem vale até 25 s depois
    // (TTL de 30 s menos a margem de 5 s do cache); se o proxy a servisse
    // dentro da margem, a renovação passaria para o Server Component, que não
    // consegue gravar cookie, e o navegador ficaria com o refresh token antigo.
    const exp = EXPIRACAO_DO_TOKEN_S * 1000;
    relogio.agora = exp - 100_000; // fora da margem: grava a entrada
    await pedir("/app/inbox");
    expect(estado.usuarios).toBe(1);
    expect(estado.renovacoes).toBe(0);

    relogio.agora = exp - 80_000; // dentro da margem, com a entrada ainda viva
    const dentroDaMargem = await pedir("/app/inbox");
    expect(dentroDaMargem.headers.get("x-middleware-next")).toBe("1");
    expect(estado.renovacoes).toBe(1);
    expect(estado.usuarios).toBe(2);
  });

  it("a AUTORIZAÇÃO continua sendo decidida por requisição, mesmo com a identidade em cache", async () => {
    const primeira = await pedir("/admin/tenants");
    const segunda = await pedir("/admin/tenants");

    expect(primeira.headers.get("x-middleware-next")).toBe("1");
    expect(segunda.headers.get("x-middleware-next")).toBe("1");
    // Identidade: uma vez. Permissão de plataforma: uma por requisição.
    expect(estado.usuarios).toBe(1);
    expect(estado.admins).toBe(2);
  });
});
