/**
 * As peças de NAVEGADOR das rotas públicas de captura de clique.
 *
 * As duas rotas (`/api/v1/anuncios/google/[org]` e `.../meta/[org]`) recebem
 * quem CLICOU no anúncio ou no botão da landing page, não o cliente do próprio
 * app: elas devolvem redirect ou HTML, nunca `ok`/`fail` de
 * `lib/api/wrappers.ts`. O que segue aqui é o que as duas fazem igual, e que
 * duplicado divergiria justamente no caminho de erro — o menos exercitado, e o
 * que custa o lead inteiro quando quebra.
 */
import { NextResponse, type NextRequest } from "next/server";

/** Mesma lição de `lib/auth/rate-limit.ts`: sem IP identificável, não conta —
 * um balde global aqui trancaria a landing page da instalação inteira. */
export function clientIp(req: NextRequest): string | null {
  const encaminhado = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (encaminhado) return encaminhado;
  return req.headers.get("x-real-ip")?.trim() || null;
}

/**
 * O texto pré-preenchido quando NÃO há ref para embutir (hit sem o que
 * capturar, ou falha ao gravar a linha do clique).
 *
 * Tira o MARCADOR inteiro, não só o `{token}`: trocar o placeholder por vazio
 * deixava `Olá! Vim pelo site. [ref:]` na mensagem que o lead manda — um
 * colchete órfão que não casa com padrão nenhum na ingestão e que quem recebe
 * lê como defeito do link. O `replace` do `{token}` continua depois, para o
 * template que escreve o placeholder fora de colchetes.
 */
export function textoSemRef(template: string): string {
  return template
    .replace(/\s*\[[^[\]]*\{token\}[^[\]]*\]/g, "")
    .replaceAll("{token}", "")
    .trim();
}

export function whatsAppUrl(whatsappE164: string, mensagem: string): string {
  const digitos = whatsappE164.replace(/\D/g, "");
  return `https://wa.me/${digitos}?text=${encodeURIComponent(mensagem)}`;
}

/**
 * A página de saída para todo caminho que não é o feliz. Sem CSS de marca —
 * é intencionalmente neutra, porque o dono da organização é quem decide como
 * a própria landing se parece, e esta rota não é essa tela.
 */
export function paginaDeSaida(destino: string | null): NextResponse {
  if (destino) {
    return NextResponse.redirect(destino, { status: 302 });
  }
  return new NextResponse(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link indisponível</title></head><body style="font-family:system-ui,sans-serif;padding:2rem;text-align:center;color:#333"><p>Este link não está disponível no momento.</p></body></html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
