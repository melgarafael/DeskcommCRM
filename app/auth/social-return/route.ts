import { createHash } from "node:crypto";

// An external OAuth navigation omits Strict session cookies. Commit a public,
// same-origin document before returning to the authenticated screen. This page
// performs no linking and trusts none of the provider's query parameters.
const target = "/app/connections?aba=sociais";
const script = `window.location.replace(${JSON.stringify(target)});`;
const hash = createHash("sha256").update(script).digest("base64");
export function GET() {
  return new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voltando ao escreve.ai</title><body><p>Voltando para suas conexões…</p><a href="${target}">Continuar no escreve.ai</a><script>${script}</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      },
    },
  );
}
