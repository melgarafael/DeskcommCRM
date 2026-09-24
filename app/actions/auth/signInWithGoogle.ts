"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClientDeEntradaComGoogle } from "@/lib/supabase/server";
import { urlDeRetornoDoGoogle } from "@/lib/auth/entrada-com-google";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

export type SignInWithGoogleResult = {
  ok: false;
  /** `google_indisponivel` = o provedor não está habilitado nesta instalação. */
  error: "google_indisponivel" | "erro_inesperado";
};

/**
 * Entrada com Google — a METADE DE IDA do OAuth.
 *
 * Roda no servidor de propósito. O verificador de PKCE que o Google vai cobrar
 * na volta é gravado em cookie pelo `createServerClient` (ver
 * `createClientDeEntradaComGoogle`, que é quem garante que esse cookie viaje na
 * navegação de volta). Feito no navegador com a chave anon, o verificador
 * ficaria no `localStorage` — lugar de onde o `/auth/callback` do servidor não
 * o lê, e o erro seria o mesmo `PKCE code verifier not found in storage`.
 *
 * ─── Por que sem `skipBrowserRedirect` ──────────────────────────────────────
 *
 * É tentador passar, já que não existe `window` aqui. Medido no auth-js 2.116.0
 * instalado: `signInWithOAuth` já guarda a navegação — `_handleProviderSignIn`
 * só chama `window.location.assign` sob `isBrowser() && !skipBrowserRedirect`.
 * Passar a opção teria efeito colateral: ela acrescenta
 * `skip_http_redirect=true` à URL do `/authorize` (auth-js, linha 4818), que é
 * exatamente a instrução "não redirecione o navegador" — o oposto do que
 * queremos numa página que acabou de receber um clique.
 *
 * ─── Por que não há limite de tentativas aqui ───────────────────────────────
 *
 * Esta chamada NÃO fala com o GoTrue: o auth-js monta a URL do `/authorize`
 * localmente (`_getUrlForProvider`) e devolve. Não há orçamento a gastar nem
 * conta a proteger — quem gasta é a volta, no `/auth/callback`, e lá o
 * `code` é de uso único e assinado pelo GoTrue.
 *
 * Em caso de erro, devolve discriminador para a tela mostrar (o Google pode não
 * estar habilitado na instalação). No sucesso, `redirect()` não retorna: o
 * navegador sai daqui direto para o Google.
 */
export async function signInWithGoogle(
  params: { next?: string; convite?: string } = {},
): Promise<SignInWithGoogleResult> {
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const supabase = await createClientDeEntradaComGoogle();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: urlDeRetornoDoGoogle(env.NEXT_PUBLIC_APP_URL, params) },
  });

  if (error || !data?.url) {
    // "Unsupported provider: provider is not enabled" é o que o GoTrue responde
    // quando ninguém ligou o provedor Google no projeto — o operador precisa
    // saber que o conserto é na configuração, e não tentar de novo.
    const indisponivel = /provider is not enabled|unsupported provider/i.test(error?.message ?? "");

    await audit({
      action: "auth.google_signin_failed",
      metadata: {
        motivo: indisponivel ? "provedor_indisponivel" : "url_ausente",
        reason: error?.message ?? "data.url ausente",
      },
      requestId,
    });

    return { ok: false, error: indisponivel ? "google_indisponivel" : "erro_inesperado" };
  }

  // Server-side redirect: os Set-Cookie do verificador de PKCE saem junto.
  redirect(data.url);
}
