import { headers } from "next/headers";
import { env } from "@/lib/env";

/**
 * Injeta a config pública do Supabase em runtime, antes do JS da app rodar.
 *
 * Por que existe: numa imagem Docker genérica (self-host), as NEXT_PUBLIC_* NÃO
 * são queimadas no bundle — este componente lê os valores REAIS do projeto do
 * usuário (via `env`, que parseia process.env inteiro em runtime no servidor) e
 * os entrega ao browser em `window.__PUBLIC_ENV__`. `lib/supabase/browser.ts`
 * lê dali.
 *
 * `await headers()` força render dinâmico: garante que o script use o env de
 * runtime, nunca o placeholder embutido durante `next build`.
 */
export async function PublicEnvScript() {
  await headers();

  const payload = JSON.stringify({
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    // Exposto pro Sentry do browser respeitar o opt-out (SENTRY_DSN=off) em runtime,
    // sem rebuild. DSN não é segredo. Ver lib/sentry/dsn.ts.
    SENTRY_DSN: env.SENTRY_DSN,
    // Marca da instalação (white-label): os client components (Sidebar, AdminSidebar)
    // leem daqui. Não são segredo — já aparecem na tela. Ver lib/branding.ts.
    APP_NAME: env.APP_NAME,
    APP_LOGO_URL: env.APP_LOGO_URL,
  })
    // Evita quebrar o </script> se algum valor contiver a sequência.
    .replace(/</g, "\\u003c");

  return (
    <script
      // Conteúdo derivado de env do servidor (não de input do usuário).
      dangerouslySetInnerHTML={{ __html: `window.__PUBLIC_ENV__=${payload};` }}
    />
  );
}
