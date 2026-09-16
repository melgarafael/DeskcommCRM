/**
 * A página que o LEAD vê ao voltar do consentimento do Instagram. Não há para
 * onde redirecionar (o lead não é usuário logado do CRM, não tem painel) —
 * a própria resposta do callback É o destino final, diferente do `voltar()`
 * do Google Calendar, que faz ponte de volta para uma tela do produto.
 */
import { NextResponse } from "next/server";

function escapar(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function paginaDeResultado(args: {
  status: number;
  titulo: string;
  mensagem: string;
}): NextResponse {
  const titulo = escapar(args.titulo);
  const mensagem = escapar(args.mensagem);
  const html =
    `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${titulo}</title>` +
    `<style>body{font-family:system-ui,sans-serif;background:#fafafa;color:#111;` +
    `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}` +
    `.cartao{max-width:420px;text-align:center}h1{font-size:1.25rem;margin:0 0 12px}` +
    `p{color:#555;line-height:1.5}</style></head>` +
    `<body><div class="cartao"><h1>${titulo}</h1><p>${mensagem}</p></div></body></html>`;
  return new NextResponse(html, {
    status: args.status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
