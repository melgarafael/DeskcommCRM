/**
 * Supabase client para Server Components, Route Handlers e Server Actions.
 *
 * Lê/escreve cookies via next/headers. Sempre use `getUser()` (valida JWT no
 * backend), NUNCA `getSession()` (confia no cookie local sem revalidar).
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

/**
 * Tudo o que vale para TODO cookie deste cliente, menos o `sameSite` — que é
 * justamente o que muda entre a sessão e o verificador de PKCE (ver
 * `createClientDeEntradaComGoogle`).
 *
 * ⚠️ Precisa ser FUNÇÃO, não constante de módulo: `cookieSecure()` lê
 * `env.NEXT_PUBLIC_APP_URL` em runtime, e quem importa este arquivo (direto ou
 * por `lib/audit`) costuma mockar `@/lib/env` no teste. Constante de módulo
 * executa no IMPORT — antes do mock existir — e derruba a suíte inteira com
 * "Cannot access 'envMock' before initialization".
 */
function opcoesDeCookie(sameSite: "strict" | "lax") {
  // D-01.01: cookie name canônico alinhado ao middleware.
  return {
    name: "sb-deskcomm-auth",
    sameSite,
    httpOnly: true,
    secure: cookieSecure(),
    path: "/",
  };
}

async function clienteDeServidor(sameSite: "strict" | "lax") {
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // setAll pode ser chamado de Server Component; nesse caso, ignoramos.
          // Refresh de sessão acontece no middleware do Next.
        }
      },
    },
    cookieOptions: opcoesDeCookie(sameSite),
  });
}

export async function createClient() {
  return clienteDeServidor("strict");
}

/**
 * Cliente para INICIAR a entrada com Google (OAuth) — de propósito com
 * `sameSite: "lax"`, e só por causa do cookie do VERIFICADOR de PKCE.
 *
 * ─── Por que o jar do verificador não pode ser Strict ───────────────────────
 *
 * Com `flowType: "pkce"` (que `createServerClient` força — createServerClient.js:33),
 * `signInWithOAuth` sorteia um verificador e o grava no jar de cookies DESTE
 * cliente, com estas mesmas opções. No `createClient` de sempre elas incluem
 * `sameSite: "strict"`.
 *
 * A volta do Google é navegação de outro site até o fim: o navegador sai de
 * `accounts.google.com`, o GoTrue responde 302 e o `redirect_to` cai aqui. O
 * navegador NÃO manda cookie `SameSite=Strict` numa navegação cross-site, então
 * o verificador não chega ao `/auth/callback` e a troca do `code` por sessão
 * falha com `PKCE code verifier not found in storage` — o defeito medido na
 * issue #1388. Com `Lax`, o cookie viaja nessa navegação (GET de topo) e a
 * troca fecha.
 *
 * ─── O que fica frouxo, e o que continua Strict ─────────────────────────────
 *
 * Este cliente existe para UMA chamada: `signInWithOAuth`. Depois dela o
 * verificador é segredo de uso único — morre consumido na troca, no mesmo
 * request em que é lido. Quem TROCA o `code` por sessão é `/auth/callback` com
 * o `createClient` de sempre: é ele que grava os cookies de SESSÃO, e esses
 * seguem `Strict`, como todo o resto do produto.
 *
 * (O default do próprio `@supabase/ssr` é `lax` — constants.js:6. Quem endureceu
 * para `strict` foi este arquivo; a entrada com Google é a exceção necessária,
 * não uma mudança de postura.)
 */
export async function createClientDeEntradaComGoogle() {
  return clienteDeServidor("lax");
}
