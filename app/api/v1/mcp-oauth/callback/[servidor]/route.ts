/**
 * GET /api/v1/mcp-oauth/callback/<servidor_id> — a volta do authorization
 * server de um servidor MCP externo `oauth_por_contato` (migration 9095). É a
 * `redirect_uri` registrada, UMA POR SERVIDOR (a mesma para todo contato dele),
 * derivada de `NEXT_PUBLIC_APP_URL`.
 *
 * Público no `proxy`: o navegador do contato vem de outro site e não tem
 * sessão nossa. Organização, servidor, contato e conversa saem da linha do
 * `state` (uso único, consumido ANTES da troca do code) — nunca da URL. O
 * servidor da URL só é CONFERIDO contra o do pedido, e o `iss` (RFC 9207),
 * quando vem, contra o emissor dele.
 * Responde uma página simples, sem dado sensível. Rate limit por IP.
 * Módulo opcional `mcp_por_agente` desligado (doc 252) = 404, a resposta de
 * uma rota nunca instalada.
 *
 * Retomada do turno: NÃO reabre o turno nesta fatia. O próximo turno do contato
 * (a próxima mensagem dele) já encontra o token e monta as ferramentas. A
 * decisão e o próximo passo estão em `docs/integracao/mcp-oauth-por-contato.md`.
 */
import { NextResponse, type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { paginaDoDesfecho, processarRetorno } from "@/lib/mcp/servidor-externo/do-agente/retorno";
import { createAdminClient } from "@/lib/supabase/admin";
import { comIdDaRequisicao } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";

const TETO_POR_IP = 30;
const JANELA_SEGUNDOS = 60;

const STATUS = {
  autorizado: 200,
  pedido_invalido: 410,
  recusado_pelo_contato: 200,
  servidor_indisponivel: 503,
  troca_falhou: 502,
} as const;

export async function GET(req: NextRequest, contexto: { params: Promise<{ servidor: string }> }): Promise<NextResponse> {
  const ip = ipDoCliente(req.headers) ?? "sem-ip";
  const limite = await checkRateLimit(`mcp-oauth-callback:${ip}`, TETO_POR_IP, JANELA_SEGUNDOS);
  if (!limite.allowed) {
    return comIdDaRequisicao(new NextResponse(null, { status: 429, headers: { "Retry-After": String(JANELA_SEGUNDOS) } }), req);
  }
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "mcp_por_agente"))) return comIdDaRequisicao(new NextResponse(null, { status: 404 }), req);
  const p = req.nextUrl.searchParams;
  const { servidor } = await contexto.params;
  const desfecho = await processarRetorno(admin, {
    servidor,
    iss: p.get("iss"),
    state: p.get("state"),
    code: p.get("code"),
    error: p.get("error"),
  });
  return comIdDaRequisicao(new NextResponse(paginaDoDesfecho(desfecho), {
    status: STATUS[desfecho],
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  }), req);
}
