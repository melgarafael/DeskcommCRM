/**
 * GET /api/v1/mcp-oauth/iniciar/<state> — o LINK CURTO que o agente envia ao
 * contato para ele autorizar o acesso à conta dele num servidor MCP externo
 * (`oauth_por_contato`, migration 9095).
 *
 * Público no `proxy` (`lib/auth/public-paths.ts`): quem clica é o cliente
 * final, sem sessão nossa. A autoridade é o `state` (256 bits, uso único,
 * 10 min) — esta rota só CONFERE validade e uso, sem consumir, e responde 302
 * para o authorization server com PKCE S256. Quem consome é o callback.
 * Rate limit por IP: o `state` não é adivinhável, mas a rota não precisa
 * aceitar varredura. Módulo opcional `mcp_por_agente` desligado (doc 252) =
 * 404, a resposta de uma rota nunca instalada.
 */
import { NextResponse, type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { iniciarAutorizacao, paginaDoDesfecho } from "@/lib/mcp/servidor-externo/do-agente/retorno";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const TETO_POR_IP = 30;
const JANELA_SEGUNDOS = 60;

function pagina(status: number, desfecho: Parameters<typeof paginaDoDesfecho>[0]): NextResponse {
  return new NextResponse(paginaDoDesfecho(desfecho), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(req: NextRequest, contexto: { params: Promise<{ state: string }> }): Promise<NextResponse> {
  const ip = ipDoCliente(req.headers) ?? "sem-ip";
  const limite = await checkRateLimit(`mcp-oauth-iniciar:${ip}`, TETO_POR_IP, JANELA_SEGUNDOS);
  if (!limite.allowed) {
    return new NextResponse(null, { status: 429, headers: { "Retry-After": String(JANELA_SEGUNDOS) } });
  }
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "mcp_por_agente"))) return new NextResponse(null, { status: 404 });
  const { state } = await contexto.params;
  const desfecho = await iniciarAutorizacao(admin, state);
  if (!desfecho.ok) {
    return pagina(desfecho.motivo === "pedido_invalido" ? 410 : 503, desfecho.motivo === "pedido_invalido" ? "pedido_invalido_inicio" : "servidor_indisponivel");
  }
  return new NextResponse(null, {
    status: 302,
    headers: { Location: desfecho.destino, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
