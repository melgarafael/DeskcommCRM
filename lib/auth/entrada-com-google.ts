/**
 * Entrada com Google: para onde o provedor devolve o navegador, e o que precisa
 * atravessar esse pulo.
 *
 * ─── A cadeia inteira, para quem for mexer depois ───────────────────────────
 *
 * 1. `/login` ou `/signup` → `signInWithGoogle` (server action) → `signInWithOAuth`
 *    monta a URL do `/authorize` do GoTrue com o `code_challenge` do PKCE e o
 *    verificador vai para um cookie do navegador;
 * 2. o navegador vai para o Google, consente, e o Google volta para o GoTrue;
 * 3. o GoTrue responde 302 para o `redirect_to` — esta URL, com `?code=…`;
 * 4. `/auth/callback` troca o `code` por sessão e entra no app.
 *
 * O `redirect_to` é o único canal que sobrevive ao passo 2 e 3 levando dado
 * nosso: o que o navegador tinha de nosso (cookie de sessão, e o próprio
 * verificador) está no navegador, não no Google. Por isso `next` e `convite`
 * viajam na URL — é o mesmo mecanismo que o `emailRedirectTo` do signup por
 * e-mail usa para não perder o `type` ao passar pelo GoTrue.
 *
 * ─── Por que o convite viaja ────────────────────────────────────────────────
 *
 * Sem ele, quem foi CONVIDADO e entra com Google cai no `/auth/callback` sem
 * vínculo nenhum e `ensureTenantForUser` faz o que faria com qualquer visitante:
 * abre uma organização e o torna admin dela. A pessoa termina com uma empresa
 * fantasma e um wizard que não é dela — o defeito que `lib/auth/convite-no-signup.ts`
 * existe para impedir no caminho do e-mail.
 *
 * ⚠️ O token do convite na URL NÃO é mais confiável do que o `user_metadata`: os
 * dois são escritos pelo usuário e os dois passam pelas MESMAS duas provas
 * (`verifyInviteToken` e a comparação com o e-mail que o provedor de auth
 * confirmou). Quem as aplica é `decidirConviteDoSignup`.
 */
import { safeNext } from "@/lib/auth/safe-next";

/** Onde o GoTrue devolve o navegador. Tem de estar em PUBLIC_PATHS. */
export const CAMINHO_DO_RETORNO_DO_GOOGLE = "/auth/callback";

export interface DestinoDoRetornoDoGoogle {
  next?: string | null;
  convite?: string | null;
}

/**
 * O `redirectTo` que vai no `signInWithOAuth`, absoluto e no domínio público da
 * instalação.
 *
 * Absoluto porque quem o lê é o GoTrue (e, por tabela, o Google) — os dois
 * comparam com a allowlist de redirects do projeto, e caminho relativo não
 * serve. `env.NEXT_PUBLIC_APP_URL`, e nunca `url.origin`: o header `Host` pode
 * chegar com o bind interno do container (ex.: `0.0.0.0:3000`), e o mesmo
 * motivo já está escrito em `app/auth/confirm/route.ts:69`.
 *
 * O `next` sai daqui já filtrado por `safeNext`: ele volta a nós dentro de uma
 * URL nossa, então um valor forjado não vira redirect externo nem aqui nem lá —
 * e o `/auth/callback` filtra de novo, porque a URL dele é alcançável na mão.
 */
export function urlDeRetornoDoGoogle(
  appUrl: string,
  destino: DestinoDoRetornoDoGoogle = {},
): string {
  const url = new URL(CAMINHO_DO_RETORNO_DO_GOOGLE, appUrl);

  const next = safeNext(destino.next, "/app");
  if (next !== "/app") url.searchParams.set("next", next);

  const convite = destino.convite?.trim();
  if (convite) url.searchParams.set("convite", convite);

  return url.toString();
}
