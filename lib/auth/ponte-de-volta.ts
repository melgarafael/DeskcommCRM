import { createHash } from "node:crypto";

/**
 * A PONTE DE VOLTA — o documento same-origin que fecha uma navegação de OAuth.
 *
 * ─── O defeito que ela existe para não deixar voltar (issue #1646) ───────────
 *
 * O cookie de sessão do produto é `sameSite: "strict"` (`lib/supabase/server.ts`).
 * Strict retém o cookie em TODA navegação cujo initiator é outro site, e a volta
 * de um consentimento OAuth é a cadeia inteira: `accounts.google.com` → GoTrue →
 * rota nossa. Responder essa navegação com um 302 para a tela autenticada NÃO
 * rompe a cadeia: o salto seguinte continua cross-site, o cookie não viaja, e o
 * `proxy.ts` manda a pessoa para `/login?next=%2Fapp` — como se o login tivesse
 * falhado, embora a sessão já esteja criada. Medido no relato da issue: o login
 * termina em `/login?next=%2Fapp`, e `auth.sessions` ganhou a linha, com
 * `last_sign_in_at` atualizado; recarregando `/app`, a pessoa ESTÁ logada.
 *
 * A ponte resolve trocando QUEM INICIA a navegação seguinte: este HTML volta com
 * 200 no nosso próprio origin, e o `location.replace` de dentro dele é disparado
 * por um documento nosso — initiator same-site, o cookie Strict viaja. É o mesmo
 * mecanismo já usado em `app/auth/social-return/route.ts` e no retorno da agenda
 * (`app/api/v1/agenda/google/callback/route.ts`).
 *
 * ─── Por que NÃO afrouxar o cookie ──────────────────────────────────────────
 *
 * `Strict` é o que impede que qualquer site de terceiros dispare navegação
 * top-level GET AUTENTICADA contra o CRM. Baixar o cookie de SESSÃO para `Lax`
 * consertaria uma tela trocando a superfície do produto inteiro. O que continua
 * frouxo neste fluxo é só o verificador de PKCE da IDA (`Lax`, de uso único,
 * `createClientDeEntradaComGoogle`) — nunca a sessão.
 *
 * ─── Contrato ───────────────────────────────────────────────────────────────
 *
 * `destino` é caminho do NOSSO produto, já filtrado por `safeNext` no ponto de
 * chamada. Nada da query original chega ao documento: o valor entra escapado no
 * `<a>` (fallback sem JS) e como literal de script, coberto pelo hash do CSP.
 */

/**
 * Literal de string seguro DENTRO de `<script>`.
 *
 * `JSON.stringify` fecha aspas, barras e controles — mas deixa o `<` passar, e o
 * HTML termina um `<script>` no PRIMEIRO `</script>` que encontrar. O destino
 * desta ponte já vem de fora (o `next` da URL, que `safeNext` filtra mas não
 * sanitiza: `</script><script>…` é um caminho relativo-na-raiz válido para ele),
 * então o `<` sai como `\u003c`. Dentro de `<script>` entidade HTML não é
 * decodificada — o escape Unicode é o único jeito de manter o valor sem abrir
 * tag nova, e o hash do CSP continua conferindo com o texto que o navegador
 * executa.
 */
function literalDeScript(valor: string): string {
  return JSON.stringify(valor).replace(/</g, "\\u003c");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param destino  caminho interno já filtrado por `safeNext`
 * @param nomeDaMarca  `marcaDaSaida(null).nome` (nunca lança)
 * @param mensagem  texto visível enquanto o documento não segue
 */
export function respostaDePonte(destino: string, nomeDaMarca: string, mensagem: string): Response {
  const script = `window.location.replace(${literalDeScript(destino)});`;
  const hash = createHash("sha256").update(script).digest("base64");
  const alvo = escapeHtml(destino);
  const nome = escapeHtml(nomeDaMarca);

  return new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voltando ao ${nome}</title><body><p>${escapeHtml(mensagem)}</p><a href="${alvo}">Continuar no ${nome}</a><script>${script}</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // `no-store`: o documento é o último passo de um fluxo com `code` de uso
        // único na URL. Guardá-lo em cache serviria a ponte errada depois.
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      },
    },
  );
}
