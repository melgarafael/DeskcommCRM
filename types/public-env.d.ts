/**
 * Config pública injetada em RUNTIME pelo <PublicEnvScript/> (app/public-env-script.tsx).
 *
 * Permite uma imagem Docker GENÉRICA (self-host): as NEXT_PUBLIC_* não são
 * queimadas no bundle em build-time — o servidor injeta os valores reais do
 * projeto Supabase do usuário a cada request. No Vercel/dev cai no fallback
 * process.env.NEXT_PUBLIC_* (baked), então nada muda lá.
 */
interface PublicEnv {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  SENTRY_DSN?: string;
  /** Marca da instalação (white-label). Ver `lib/branding.ts`. */
  APP_NAME?: string;
  APP_LOGO_URL?: string;
}

interface Window {
  __PUBLIC_ENV__?: PublicEnv;
}
