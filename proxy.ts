import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { fetchDoServidor } from "@/lib/supabase/fetch-do-servidor";
import { urlDoSupabaseNoServidor } from "@/lib/supabase/url-do-servidor";
import { isPublicPath } from "@/lib/auth/public-paths";
import { CABECALHO_SEM_CSS, PARAMETRO_SEM_CSS } from "@/lib/branding/sem-css-personalizado";
import {
  verifyImpersonateCookieEdge,
  IMPERSONATE_COOKIE_NAME_EDGE,
} from "@/lib/impersonate/cookie-edge";

const COOKIE_NAME = "sb-deskcomm-auth";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function proxy(request: NextRequest) {
  // Saída de emergência do CSS personalizado. ANTES do `NextResponse.next`: ele
  // copia os cabeçalhos da requisição no momento em que é criado, e o que for
  // posto depois não chega aos Server Components. Sempre gravado, para um
  // cabeçalho forjado pelo cliente não valer.
  request.headers.set(
    CABECALHO_SEM_CSS,
    request.nextUrl.searchParams.has(PARAMETRO_SEM_CSS) ? "1" : "0",
  );
  // O caminho atual, para os Server Components (o `next` do desafio de MFA em
  // `exigirProvaDeMfa`). Mesma regra: antes do `next`, e sempre gravado.
  request.headers.set("x-pathname", request.nextUrl.pathname);
  // O id da requisição (#3971): o que veio do navegador, se for um UUID, ou um
  // novo. Mesma regra: antes do `next`, para chegar a quem lê `x-request-id`
  // (Server Actions, `requestIdOf(req)`) e daí ao audit log.
  const recebido = request.headers.get("x-request-id");
  const requestId = recebido && UUID.test(recebido) ? recebido : crypto.randomUUID();
  request.headers.set("x-request-id", requestId);
  const response = NextResponse.next({ request: { headers: request.headers } });

  const { pathname, search } = request.nextUrl;
  // Sob `/api/`, o `X-Request-Id` da RESPOSTA é de `ok()`/`fail()`: é o id que a
  // rota grava no log e no audit. Cabeçalho posto aqui VENCE o da rota — o Next
  // só acrescenta o da rota quando o do middleware não existe — e o `ID:` que a
  // tela mostra deixava de existir no log. Fora de `/api/`, ninguém mais o põe.
  if (!pathname.startsWith("/api/")) {
    response.headers.set("x-request-id", requestId);
  }
  // Recupera retornos de OAuth social já emitidos antes da landing pública existir.
  // Apenas a navegação é tratada: o vínculo de conta segue protegido pelos guards canônicos.
  // Passa adiante só o SINAL `connected=1` — nunca o `connect_token` nem o valor recebido.
  if (
    request.method === "GET" &&
    pathname === "/app/connections" &&
    request.nextUrl.searchParams.has("connected") &&
    request.nextUrl.searchParams.has("connect_token")
  ) {
    const landing = NextResponse.redirect(new URL("/auth/social-return?connected=1", request.url));
    landing.headers.set("Cache-Control", "no-store");
    landing.headers.set("Referrer-Policy", "no-referrer");
    return landing;
  }

  // EPIC-11: the admin surface is reached by PATH (`/admin/*`) — the self-host kit
  // points `NEXT_PUBLIC_ADMIN_URL` at the same host as the app and maps no `admin.`
  // sub-domain. The host-based branch below stays a NOOP today and only exists as
  // documentation of the intended deploy topology.
  const host = request.headers.get("host") ?? "";
  const isAdminSurface = host.startsWith("admin.") || pathname.startsWith("/admin");

  if (isPublicPath(pathname)) {
    return response;
  }

  const supabase = createServerClient(
    // #1082: base na URL pública, endereço interno só no transporte (ver
    // `lib/supabase/fetch-do-servidor.ts`). O middleware não gera link, mas
    // segue a mesma regra dos outros dois clients — um desenho só.
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: {
        fetch: fetchDoServidor(
          urlDoSupabaseNoServidor(env.SUPABASE_SERVER_URL, env.NEXT_PUBLIC_SUPABASE_URL),
          env.NEXT_PUBLIC_SUPABASE_URL,
        ),
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
      cookieOptions: {
        name: COOKIE_NAME,
        sameSite: "strict",
        httpOnly: true,
        secure: cookieSecure(),
        path: "/",
      },
    },
  );

  // Validate JWT server-side (NEVER use getSession on backend per CLAUDE.md).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // API routes must respond with JSON envelope (contract: {error:{code,message}})
    // — never redirect HTML to JSON consumers. UI routes redirect to /login as before.
    if (pathname.startsWith("/api/")) {
      return new NextResponse(
        JSON.stringify({
          error: {
            code: "unauthenticated",
            message: "Authentication required",
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
        },
      );
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  // EPIC-11 S-11.07: validate impersonate cookie on /app/* paths. Middleware
  // runs in Edge — no DB access, only HMAC + expiry. On any failure we delete
  // the presentation cookie. The database support session remains authoritative:
  // expired/revoked support still blocks the app until explicit exit.
  if (pathname.startsWith("/app")) {
    const impCookie = request.cookies.get(IMPERSONATE_COOKIE_NAME_EDGE)?.value;
    if (impCookie) {
      const result = await verifyImpersonateCookieEdge(
        impCookie,
        env.IMPERSONATE_COOKIE_SECRET ?? "",
      );
      if (!result.valid) {
        console.warn(
          `[middleware] impersonate cookie invalid (${result.reason ?? "unknown"}) — clearing`,
        );
        response.cookies.delete(IMPERSONATE_COOKIE_NAME_EDGE);
      }
    }
  }

  // /admin/* additionally requires platform_admin (early gate — authoritative
  // check is server-side in `requirePlatformAdmin`). Skip the RPC for
  // `/admin/forbidden` (rendered to non-admins, would otherwise loop).
  if (isAdminSurface && pathname.startsWith("/admin") && pathname !== "/admin/forbidden") {
    const { data: isAdmin, error } = await supabase.rpc("fn_is_platform_admin");
    if (error || !isAdmin) {
      return NextResponse.redirect(new URL("/admin/forbidden", request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    // Run on all paths except static assets / Next internals.
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)",
  ],
};
