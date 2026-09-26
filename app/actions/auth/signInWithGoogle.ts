"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClientDeEntradaComGoogle } from "@/lib/supabase/server";
import { urlDeRetornoDoGoogle } from "@/lib/auth/entrada-com-google";
import { estadoDoProvedorGoogle } from "@/lib/auth/provedor-google";
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
 * ─── Por que há uma leitura de settings ANTES do redirect (issue #1652) ─────
 *
 * O ramo `google_indisponivel` abaixo esperava um `error` do `signInWithOAuth`
 * dizendo "provider is not enabled". Medido: esse `error` NUNCA vem. O auth-js
 * monta a URL do `/authorize` localmente (`_getUrlForProvider`) e devolve
 * `{ data: { url } }, error: null` — inclusive com o provedor desligado. Quem
 * recusa é o `/authorize`, já no navegador, e a recusa é uma página de JSON
 * cru (`{"code":400,…,"msg":"Unsupported provider: provider is not enabled"}`)
 * para onde a pessoa é mandada fora do CRM e sem caminho de volta.
 *
 * Por isso a conferência é `estadoDoProvedorGoogle()` (lib/auth/provedor-google):
 * `GET /auth/v1/settings`, público, com a anon key — a mesma resposta que o
 * GoTrue usa para decidir se aceita o `/authorize`. `desligado` devolve
 * `google_indisponivel` ANTES de montar a URL; `desconhecido` (rede, corpo
 * inesperado, resposta ≠ 200) segue o comportamento de sempre, para a leitura
 * nunca bloquear por engano quem tem o provedor ligado.
 *
 * ─── Por que não há limite de tentativas aqui ───────────────────────────────
 *
 * O `signInWithOAuth` de baixo NÃO fala com o GoTrue: o auth-js monta a URL do
 * `/authorize` localmente e devolve. Não há orçamento a gastar nem conta a
 * proteger na ida — quem gasta é a volta, no `/auth/callback`, e lá o `code` é
 * de uso único e assinado pelo GoTrue. A única fala com o GoTrue antes do
 * redirect é a leitura de settings, que é um GET sem estado e sem teto.
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

  // Antes de qualquer coisa: o GoTrue só diria "provider is not enabled" lá na
  // frente, com o navegador já fora do CRM (issue #1652). Aqui a recusa ainda
  // cabe dentro da tela, embaixo do botão.
  //
  // SEM linha de auditoria neste ramo. Esta action é pública e sem limite de
  // tentativas: com o provedor desligado, cada chamada anônima gravaria 1 linha
  // em `api_audit_log` — tabela append-only com piso de expurgo de 90 dias.
  // Mesma doutrina de `app/auth/callback/route.ts` (os ramos antes do gate) e de
  // `app/api/v1/agenda/google/callback/route.ts`: auditoria só depois de quem
  // chama provar alguma coisa. Aqui ninguém provou nada; a tela diz o motivo.
  const estado = await estadoDoProvedorGoogle();
  if (estado === "desligado") {
    return { ok: false, error: "google_indisponivel" };
  }

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
