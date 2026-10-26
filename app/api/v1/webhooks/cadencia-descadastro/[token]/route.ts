/**
 * GET /api/v1/webhooks/cadencia-descadastro/:token — link de descadastro que
 * entra no fim de todo e-mail de cadência. Clicado pelo LEAD no navegador, sem
 * sessão — mesma classe de rota pública que o pixel (`../cadencia-pixel/`).
 *
 * LGPD: o pedido de saída é IRREVERSÍVEL por esta rota (não há "desfazer" —
 * reinscrição comum não remove a supressão). Para
 * cada cadência ATIVA em que este CONTATO esteja inscrito, para a inscrição
 * com `motivo_parada='descadastro'`. Suprime por CONTATO, não só pela
 * cadência que originou o clique: quem pediu para sair não quer receber de
 * NENHUMA outra sequência desta organização — `POST .../inscricoes` (a rota
 * de inscrição) recusa reinscrever um contato com descadastro registrado
 * (ver o comentário lá).
 *
 * Clique repetido (o lead abre o link de novo, ou dois cliques em abas
 * diferentes) é IDEMPOTENTE: só conta e audita a PRIMEIRA vez — o filtro
 * `motivo_parada is distinct from descadastro` na RPC garante que a segunda passada não
 * encontra linha para mudar.
 */
import type { NextRequest } from "next/server";

import { registrarFalhaDeToken, tokenFailureLimited } from "@/lib/auth/rate-limit";
import { verifyCadenciaLink } from "@/lib/cadencias/token";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

function paginaDeConfirmacao(mensagem: string): Response {
  const html = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Descadastro</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 24px;color:#1a1a1a;text-align:center}</style>
</head>
<body><p>${mensagem}</p></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  if (await tokenFailureLimited(token)) return paginaDeConfirmacao("Não foi possível processar agora. Tente de novo em alguns minutos.");
  const payload = verifyCadenciaLink(token, "descadastro");
  if (!payload) {
    await registrarFalhaDeToken(token);
    return paginaDeConfirmacao("Link inválido ou expirado.");
  }

  const admin = createAdminClient();
  try {
    const { error } = await admin.rpc("fn_cadencia_descadastrar", {
      p_enrollment_id: payload.enrollment_id,
      p_organization_id: payload.organization_id,
    });
    if (error) {
      logger.error("[cadencia-descadastro] update falhou", { codigo: "cadencia_unsubscribe_write_failed" });
      return paginaDeConfirmacao("Não foi possível processar agora. Tente de novo em alguns minutos.");
    }

    return paginaDeConfirmacao("Você não vai mais receber estes e-mails. Obrigado.");
  } catch {
    logger.error("[cadencia-descadastro] falhou", {
      codigo: "cadencia_public_handler_failed",
    });
    return paginaDeConfirmacao("Não foi possível processar agora. Tente de novo em alguns minutos.");
  }
}
