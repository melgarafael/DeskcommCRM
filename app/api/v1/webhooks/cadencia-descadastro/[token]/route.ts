/**
 * /api/v1/webhooks/cadencia-descadastro/:token — link de descadastro que entra
 * no fim de todo e-mail de cadência, sem sessão, mesma classe de rota pública
 * que o pixel (`../cadencia-pixel/`).
 *
 * GET e HEAD NÃO mudam estado: filtro de e-mail e leitor automático abrem links
 * sem a pessoa ter pedido nada, e a prova de tela mediu os dois parando a
 * inscrição, sem volta. O GET só mostra a página com o botão de confirmar.
 *
 * POST descadastra. É o botão da página e o cabeçalho `List-Unsubscribe-Post`
 * (RFC 8058), que o provedor de e-mail chama sem cookie: o token assinado é a
 * credencial, por isso não há sessão nem CSRF aqui, e o corpo é ignorado.
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
 * POST repetido (duas abas, ou o provedor e o botão) é IDEMPOTENTE: só conta
 * a PRIMEIRA vez — o filtro `motivo_parada is distinct from descadastro` na
 * RPC garante que a segunda passada não encontra linha para mudar.
 *
 * Auditoria: a primeira passada grava UMA linha `lgpd.consent_changed` em
 * `api_audit_log`, com a organização do TOKEN assinado (nunca do corpo, que é
 * ignorado) e só ids e a contagem — sem e-mail, IP ou user-agent de quem
 * clicou. A repetida não grava: a RPC devolve 0, nada mudou, e não há
 * mutação a auditar.
 */
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { registrarFalhaDeToken, tokenFailureLimited } from "@/lib/auth/rate-limit";
import { verifyCadenciaLink } from "@/lib/cadencias/token";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const CABECALHOS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const TENTE_DEPOIS = "Não foi possível processar agora. Tente de novo em alguns minutos.";

function pagina(corpo: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Descadastro</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 24px;color:#1a1a1a;text-align:center}button{font:inherit;min-height:44px;padding:0 24px;cursor:pointer}</style>
</head>
<body>${corpo}</body></html>`;
  return new Response(html, { status, headers: CABECALHOS });
}

// Sem `action`: o formulário volta à própria URL, e o token nunca é copiado para o HTML.
const FORMULARIO = `<p>Quer parar de receber estes e-mails?</p>
<form method="post"><button type="submit">Confirmar descadastro</button></form>`;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  if (await tokenFailureLimited(token)) return pagina(`<p>${TENTE_DEPOIS}</p>`);
  if (!verifyCadenciaLink(token, "descadastro")) {
    await registrarFalhaDeToken(token);
    return pagina("<p>Link inválido ou expirado.</p>");
  }
  return pagina(FORMULARIO);
}

// Explícito: sem ele o Next responde o HEAD chamando o GET, e aí a garantia
// dependeria de o GET nunca mudar. Não valida nem conta o token.
export async function HEAD(): Promise<Response> {
  return new Response(null, { status: 200, headers: CABECALHOS });
}

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  if (await tokenFailureLimited(token)) return pagina(`<p>${TENTE_DEPOIS}</p>`, 503);
  const payload = verifyCadenciaLink(token, "descadastro");
  if (!payload) {
    await registrarFalhaDeToken(token);
    return pagina("<p>Link inválido ou expirado.</p>", 400);
  }

  const admin = createAdminClient();
  try {
    const { data: paradas, error } = await admin.rpc("fn_cadencia_descadastrar", {
      p_enrollment_id: payload.enrollment_id,
      p_organization_id: payload.organization_id,
    });
    if (error) {
      logger.error("[cadencia-descadastro] update falhou", { codigo: "cadencia_unsubscribe_write_failed" });
      return pagina(`<p>${TENTE_DEPOIS}</p>`, 503);
    }

    if (typeof paradas === "number" && paradas > 0) {
      await audit({
        action: "lgpd.consent_changed",
        organizationId: payload.organization_id,
        resourceType: "email_cadence_enrollment",
        resourceId: payload.enrollment_id,
        bypassedRls: true,
        metadata: { canal: "email_cadencia", consentimento: "revogado", origem: "link_descadastro", inscricoes_paradas: paradas },
      });
    }

    return pagina("<p>Você não vai mais receber estes e-mails. Obrigado.</p>");
  } catch {
    logger.error("[cadencia-descadastro] falhou", {
      codigo: "cadencia_public_handler_failed",
    });
    return pagina(`<p>${TENTE_DEPOIS}</p>`, 503);
  }
}
