/**
 * Supabase client para Client Components (browser).
 *
 * Use este em qualquer arquivo com "use client". NUNCA em Server Components,
 * Route Handlers, ou middleware — eles devem usar `lib/supabase/server.ts`.
 *
 * Sessão persiste via cookie SameSite=Strict gerenciado pelo @supabase/ssr.
 */

import { createBrowserClient } from "@supabase/ssr";

let _client: ReturnType<typeof createBrowserClient> | null = null;

/**
 * QUEM DIZ AO SOCKET DO REALTIME QUAL É O TOKEN.
 *
 * O cookie de sessão é httpOnly (CLAUDE.md), então o supabase-js do browser não
 * enxerga a sessão — `auth.getSession()` devolve null. A callback PADRÃO do
 * supabase-js nesse caso é `_getAccessToken()`, e ela termina em
 * `?? this.supabaseKey`: **o socket assina com a anon key**. Canal anônimo
 * responde SUBSCRIBED, a RLS filtra do outro lado, e nada é entregue — morte
 * silenciosa, porque todo sinal disponível diz "saudável".
 *
 * ⚠️ POR QUE AQUI E NÃO EM `setAuth()`, QUE ERA A CORREÇÃO ANTERIOR. O repo
 * corrigia isto chamando `supabase.realtime.setAuth(token)` antes de assinar.
 * Isso PAROU DE FUNCIONAR num bump de dependência, sem uma linha de código
 * nossa mudar: a partir do realtime-js 2.112.x a callback passou a vencer o
 * token manual, o que a própria biblioteca documenta em `setAuth` —
 *
 *   "the callback is the source of truth: the client remains in callback mode
 *    and continues to refresh from it on heartbeat, even after a
 *    bootstrap/override `setAuth(token)` call"
 *
 * — e o `_manuallySetToken` que protegia o token manual virou sempre `false`,
 * porque o SupabaseClient SEMPRE instala uma callback. Medido: o token do
 * usuário sobrevivia ~2ms ao `setAuth`, e o heartbeat seguinte (~30s) o
 * substituía pela anon key de qualquer forma.
 *
 * A callback resolve a RENOVAÇÃO. O primeiro join ainda exige bootstrap:
 * medido no SDK 2.112.4, connect() inicia a busca mas subscribe() pode montar
 * o join antes dela. prepareRealtimeAuthentication aguarda a mesma fonte e
 * setAuth(token), sem remover a callback. Não é a antiga segunda autoridade.
 *
 * Substituir a callback é a via suportada, e ela é melhor que só `setAuth` por
 * uma razão que independe do bug: o socket a chama de novo a cada heartbeat e
 * em cada reconexão. Um token de 1h deixa de ser uma bomba-relógio — quem
 * ficava com o inbox aberto por mais de uma hora perdia o tempo real e nada
 * avisava.
 *
 * `settings.realtime` sobrescreve a callback padrão porque entra depois no
 * spread do SupabaseClient (`_initRealtimeClient({...defaults}, settings.realtime)`),
 * e `accessToken` é opção pública de `RealtimeClientOptions`. Não tocamos em
 * `supabase.auth`: passar `accessToken` no nível do CLIENT (e não do realtime)
 * transformaria `.auth` num Proxy que lança.
 */
const MARGEM_DE_RENOVACAO_MS = 60_000;

let tokenEmCache: { valor: string; expiraEm: number } | null = null;
let buscaEmVoo: Promise<string | null> | null = null;
let authEpoch = 0;

/** Invalida inclusive respostas em voo de um contexto que acabou. */
export function resetRealtimeAuthentication(): void {
  authEpoch++;
  tokenEmCache = null;
  buscaEmVoo = null;
}

/** Compatibilidade com os testes do cache. */
export const __resetTokenDoRealtime = resetRealtimeAuthentication;

async function tokenDoRealtime(): Promise<string | null> {
  const epoch = authEpoch;
  // Válido e longe de expirar: serve o cache. Sem isto seria uma requisição a
  // cada heartbeat — ~2/min por aba aberta, para um token que vale uma hora.
  if (tokenEmCache && Date.now() < tokenEmCache.expiraEm - MARGEM_DE_RENOVACAO_MS) {
    return tokenEmCache.valor;
  }
  // Coalesce: N canais assinando juntos fazem UMA requisição, não N.
  buscaEmVoo ??= (async () => {
    try {
      const res = await fetch("/api/v1/auth/realtime-token", { credentials: "include" });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        data?: { access_token?: string; expires_at?: number | null };
      };
      if (epoch !== authEpoch) return null;
      const token = body.data?.access_token;
      if (!token) return null;
      // `expires_at` é epoch em SEGUNDOS. Sem ele, trata como já vencido na
      // próxima pergunta: revalidar de graça é melhor que servir token morto.
      const expiraEm = body.data?.expires_at ? body.data.expires_at * 1000 : 0;
      tokenEmCache = { valor: token, expiraEm };
      return token;
    } catch {
      // Ausência interna não autoriza canal: bootstrap recusa e a callback
      // externa lança, para o SDK não rebaixar um token existente a anônimo.
      return null;
    } finally {
      // ⚠️ NUNCA memoizar a promessa além da requisição: uma falha transitória
      // (sessão estabelecendo, cookie em renovação) condenaria o carregamento
      // inteiro a canais anônimos. O que se guarda é o token BOM, com prazo;
      // o que não se guarda é a falha. O critério não é "deu erro?" — é "o
      // resultado guardado é o resultado DESEJADO?".
      if (epoch === authEpoch) buscaEmVoo = null;
    }
  })();
  return buscaEmVoo;
}

/** O SDK 2.112.4 inicia connect antes de resolver a callback. O primeiro join
 * precisa deste bootstrap; a MESMA callback continua renovando o token depois. */
export async function prepareRealtimeAuthentication(): Promise<void> {
  const epoch = authEpoch;
  const token = await tokenDoRealtime();
  if (!token || epoch !== authEpoch) throw new Error("Autenticação de tempo real indisponível.");
  await createClient().realtime.setAuth(token);
  if (epoch !== authEpoch) throw new Error("O contexto de tempo real mudou.");
}

export function createClient() {
  // Singleton no browser pra reaproveitar canais Realtime e auth state.
  if (_client) return _client;

  // Self-host (imagem genérica): valores injetados em runtime pelo
  // <PublicEnvScript/>. Vercel/dev: fallback pro process.env.NEXT_PUBLIC_*
  // (baked em build). Ler a URL do Supabase daqui é o que permite uma única
  // imagem servir qualquer projeto Supabase sem rebuild.
  const runtime =
    typeof window !== "undefined" ? window.__PUBLIC_ENV__ : undefined;
  const url = runtime?.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    runtime?.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "[supabase/browser] NEXT_PUBLIC_SUPABASE_URL ou NEXT_PUBLIC_SUPABASE_ANON_KEY ausentes.",
    );
  }

  _client = createBrowserClient(url, key, {
    // D-01.01: cookie name canônico alinhado ao middleware/server.
    cookieOptions: {
      name: "sb-deskcomm-auth",
      sameSite: "strict",
      path: "/",
    },
    realtime: { accessToken: async () => {
      const token = await tokenDoRealtime();
      if (!token) throw new Error("Token de tempo real indisponível.");
      return token;
    } },
  });
  return _client;
}
