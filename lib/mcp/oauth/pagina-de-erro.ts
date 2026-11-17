/**
 * Página mínima de erro do `authorize` — para quando NÃO se pode devolver o
 * erro ao cliente (endereço de volta não conferido). Texto fixo nosso, nada da
 * query refletido; CSP sem script.
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function paginaDeErroOAuth(mensagem: string, status: number, requestId: string): Response {
  return new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conexão não autorizada</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">Não foi possível continuar a conexão</h1><p>${escapeHtml(mensagem)}</p><p style="color:#666;font-size:.8rem">Código: ${escapeHtml(requestId)}</p></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "X-Request-Id": requestId,
      },
    },
  );
}
