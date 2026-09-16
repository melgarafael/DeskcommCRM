import { headers } from "next/headers";
import { env } from "@/lib/env";

/**
 * Injeta a config pública do Supabase em runtime, antes do JS da app rodar.
 *
 * Por que existe: numa imagem Docker genérica (self-host) as NEXT_PUBLIC_* **SÃO**
 * queimadas no bundle com o valor do BUILD — que no `Dockerfile` é
 * `https://placeholder.supabase.co`. Este componente lê os valores REAIS do
 * projeto do usuário (via `env`, que parseia `process.env` INTEIRO em runtime no
 * servidor) e os entrega ao browser em `window.__PUBLIC_ENV__`.
 * `lib/supabase/browser.ts` lê dali.
 *
 * ⚠️ ESTE PARÁGRAFO AFIRMAVA O CONTRÁRIO ("NÃO são queimadas"), e a frase errada
 * é o que escondeu um bug por meses. Medido no build de produção deste repo
 * (Next 16.3.1, Turbopack): `lib/branding/logo.ts` acessava
 * `process.env.NEXT_PUBLIC_SUPABASE_URL` de forma ESTÁTICA e o compilador dobrou
 * a função inteira em `function n(){return"https://placeholder.supabase.co".trim()}`.
 * Toda instalação Docker que subisse um logo recebia `<img>` quebrado — na barra
 * lateral, na fachada do `/login` e no e-mail de convite.
 *
 * O que salva o RESTO do app não é ausência de queima: é `lib/env.ts` fazer
 * `schema.safeParse(process.env)` sobre o OBJETO INTEIRO, que a substituição do
 * compilador não alcança. Quem escrever `process.env.NEXT_PUBLIC_ALGO` direto
 * volta a queimar. Vigiado por `tests/unit/marca-nao-pode-assar-o-dominio.test.ts`.
 *
 * `await headers()` força render dinâmico: garante que o script use o env de
 * runtime, nunca o placeholder embutido durante `next build`.
 *
 * ── Por que a MARCA entra por prop, e o Supabase não ─────────────────────────
 *
 * Até esta onda as duas chaves de marca eram `env.APP_NAME` e `env.APP_LOGO_URL`
 * — o arquivo de instalação CRU. Consequência medida: `platform_branding.logo_url`
 * e `MarcaDeSaida.logoUrl` existiam e não tinham nenhum leitor, porque o único
 * render de logo do produto (`components/shell/Sidebar.tsx`) lê
 * `window.__PUBLIC_ENV__.APP_LOGO_URL`. O operador salvava um valor que nada
 * mostrava, e a tela dizia "salvo".
 *
 * A correção não é este arquivo ler o banco: ele injeta o payload no `<head>` e
 * não é o lugar onde a precedência das camadas mora. Ele passa a RECEBER a marca
 * já resolvida, montada pela mesma função que o título da aba e o CSS da marca
 * usam (`marcaResolvida()`, em `app/layout.tsx`) — três montagens da pilha
 * divergiriam, e a divergência apareceria como aba com uma marca e barra lateral
 * com outra. As chaves do Supabase continuam vindo de `env` porque não têm
 * camada nenhuma acima: não há "URL do Supabase da organização".
 */
export async function PublicEnvScript({
  marca,
}: {
  /**
   * A marca da INSTALAÇÃO já resolvida (banco acima, `.env` embaixo). Quem
   * resolve é o layout raiz; recebê-la pronta é o que impede este componente de
   * virar uma segunda fonte de verdade sobre precedência de marca.
   */
  readonly marca: { readonly name: string; readonly logoUrl: string | null };
}) {
  await headers();

  const payload = JSON.stringify({
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    // Exposto pro Sentry do browser respeitar o opt-out (SENTRY_DSN=off) em runtime,
    // sem rebuild. DSN não é segredo. Ver lib/sentry/dsn.ts.
    SENTRY_DSN: env.SENTRY_DSN,
    // Marca da instalação (white-label): os client components (Sidebar, AdminSidebar)
    // leem daqui. Não são segredo — já aparecem na tela. Ver lib/branding.ts.
    APP_NAME: marca.name,
    // `?? ""` e não `?? null`: do outro lado da fronteira quem lê é
    // `resolveBranding` (lib/branding.ts), que trata string vazia como ausência
    // de marca — é o mesmo formato que o `.env` entregava (`APP_LOGO_URL=` vira
    // `""`), então o navegador não precisa aprender um segundo jeito de dizer
    // "não tem logo".
    APP_LOGO_URL: marca.logoUrl ?? "",
    ADVOMAX_DEPLOYMENT_MODE: env.ADVOMAX_DEPLOYMENT_MODE ? "true" : "false",
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
