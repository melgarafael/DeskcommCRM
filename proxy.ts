import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { isPublicPath } from "@/lib/auth/public-paths";
import {
  verifyImpersonateCookieEdge,
  IMPERSONATE_COOKIE_NAME_EDGE,
} from "@/lib/impersonate/cookie-edge";

const COOKIE_NAME = "sb-deskcomm-auth";

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request: { headers: request.headers } });

  // Inject X-Request-Id for downstream correlation (audit log, error wrappers).
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  response.headers.set("x-request-id", requestId);

  const { pathname, search } = request.nextUrl;
  // Expose pathname to Server Components via header (used by onboarding layout).
  response.headers.set("x-pathname", pathname);
  request.headers.set("x-pathname", pathname);

  // ---------------------------------------------------------------------
  // HSTS + CSP. Set here (not in next.config.ts `headers()`) on purpose: CSP
  // below needs the REAL runtime Supabase URL, and self-host does NOT burn
  // NEXT_PUBLIC_* into the build — the same Docker image serves every
  // install, and each reads its own `.env` at request time (see
  // app/public-env-script.tsx). A static header in next.config.ts would bake
  // in whatever placeholder was present at CI build time, not the customer's
  // actual project. The other, non-runtime-dependent security headers
  // (X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
  // Permissions-Policy) stay in next.config.ts — no reason to duplicate that
  // logic here.
  //
  // HSTS only over HTTPS: forcing it on http://localhost breaks local dev.
  // Behind Traefik (self-host default, see CLAUDE.md "Deploy em produção")
  // the app itself is reached over plain HTTP inside the docker network —
  // `x-forwarded-proto` is the only reliable signal of the ORIGINAL scheme.
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const isHttps = forwardedProto === "https" || request.nextUrl.protocol === "https:";
  if (isHttps) {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  const supabaseUrl = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseWsOrigin = `${supabaseUrl.protocol === "https:" ? "wss:" : "ws:"}//${supabaseUrl.host}`;
  const isDev = process.env.NODE_ENV !== "production";

  const cspValue = [
    "default-src 'self'",
    // No nonce plumbing exists today: 4 inline <script>/<style> blocks via
    // dangerouslySetInnerHTML (app/layout.tsx THEME_INIT_SCRIPT + marca da
    // instalação, app/public-env-script.tsx, EstiloDaMarcaDaOrganizacao.tsx)
    // — all server-derived (env/branding config, never raw user input; see
    // each file's own comments on the `<` allowlist). Threading a nonce
    // through them is a real hardening step but touches component code,
    // out of scope for a headers-only change. 'unsafe-eval' only in dev
    // (webpack HMR needs it; no eval() in app/components/lib in prod).
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // https: (not just Supabase) because APP_LOGO_URL is an admin-set
    // white-label logo that can point at ANY reseller's own domain — see
    // lib/branding, app/app/settings/marca. data:/blob: for inline
    // placeholders and local previews. supabaseUrl.origin ALSO listed
    // explicitly (not just covered by `https:`): a local/e2e Supabase
    // (`supabase start`) serves Storage over plain http, and `https:` alone
    // silently drops those <img> loads — measured breaking
    // tests/e2e/marca-logo.spec.ts (logo bitmap came back empty, CSP-blocked)
    // the first time this policy shipped.
    `img-src 'self' data: blob: https: ${supabaseUrl.origin}`,
    "font-src 'self' data:",
    // WhatsApp media (voice notes, video) plays from Supabase Storage
    // signed URLs; blob: covers local previews before upload
    // (components/inbox/composer/AttachmentPreviewDialog.tsx).
    `media-src 'self' blob: ${supabaseUrl.origin}`,
    // Supabase Auth/PostgREST (https) + Realtime (wss), resolved from the
    // ACTUAL runtime NEXT_PUBLIC_SUPABASE_URL — see comment above. WAHA and
    // the AI Gateway are called server-side only (route handlers), never
    // from the browser, so they don't belong here. Sentry goes through the
    // same-origin /monitoring tunnel (next.config.ts tunnelRoute) — no
    // external Sentry host needed.
    `connect-src 'self' ${supabaseUrl.origin} ${supabaseWsOrigin}`,
    // Sentry Session Replay ships its compression codec as a blob: Worker.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  response.headers.set("Content-Security-Policy", cspValue);

  // A few branches below return a FRESH NextResponse (401 JSON, redirects)
  // instead of `response` — this carries the two headers above onto those
  // too, so a redirect or an unauthenticated API error doesn't silently skip
  // them (HSTS especially is meant to apply per-origin, on every response).
  const applySecurityHeaders = (res: NextResponse) => {
    if (isHttps) res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.headers.set("Content-Security-Policy", cspValue);
    return res;
  };
  // ---------------------------------------------------------------------

  // EPIC-11: in dev we route by path (`/admin/*`); in prod the
  // `admin.deskcomm.com` sub-domain is mapped via Vercel rewrites to the same
  // `/admin/*` paths. The host-based branch below stays a NOOP today and only
  // exists as documentation of the intended deploy topology.
  const host = request.headers.get("host") ?? "";
  const isAdminSurface = host.startsWith("admin.") || pathname.startsWith("/admin");

  if (isPublicPath(pathname)) {
    return response;
  }

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
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
      const unauthenticated = new NextResponse(
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
      return applySecurityHeaders(unauthenticated);
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname + search);
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  // EPIC-11 S-11.07: validate impersonate cookie on /app/* paths. Middleware
  // runs in Edge — no DB access, only HMAC + expiry. On any failure we delete
  // the cookie (defence-in-depth) and let the request continue (the layout
  // re-checks server-side; downstream code that depends on the cookie will
  // simply see no impersonation in effect).
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
      return applySecurityHeaders(NextResponse.redirect(new URL("/admin/forbidden", request.url)));
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
