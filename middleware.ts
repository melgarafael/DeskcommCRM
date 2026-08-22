import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Único propósito: expor o pathname atual como header (`x-pathname`) para
 * Server Components que precisam saber "que rota é esta?" sem duplicar lógica
 * de roteamento — usado por `app/app/layout.tsx` para deixar
 * `/app/settings/billing` passar mesmo com a org suspensa por inadimplência
 * (Fase 3 do pivot ADR-0002; sem isso, o próprio redirect de suspensão
 * tornaria a tela de pagamento inalcançável exatamente quando é mais
 * necessária). Escopo restrito a `/app/*`: não introduz custo de edge runtime
 * em nenhuma outra rota do produto.
 */
export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  response.headers.set("x-pathname", request.nextUrl.pathname);
  return response;
}

export const config = {
  matcher: ["/app/:path*"],
};
