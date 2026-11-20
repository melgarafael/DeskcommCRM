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
 * reinscrição comum não remove a supressão). O token carrega só o id do
 * DESTINATÁRIO daquele envio (`email_cadence_recipients`), e a RPC resolve
 * por ele a organização, o endereço (hash) e o contato — mesmo que o negócio
 * e a inscrição já tenham sido apagados. Suprime o ENDEREÇO e o contato para
 * toda a organização, e para as inscrições ativas desse contato com
 * `motivo_parada='descadastro'`: quem pediu para sair não quer receber de
 * NENHUMA outra sequência desta organização — `POST .../inscricoes` recusa
 * reinscrever (ver o comentário lá).
 *
 * Sucesso só com supressão gravada: se o destinatário não existe mais
 * (organização apagada), a RPC devolve null e a página diz que não deu.
 *
 * POST repetido (duas abas, ou o provedor e o botão) é IDEMPOTENTE: a
 * segunda passada não cria supressão nem para inscrição de novo.
 *
 * Auditoria: a passada que muda algo grava UMA linha `lgpd.consent_changed`
 * em `api_audit_log`, com a organização resolvida do destinatário (nunca do
 * corpo, que é ignorado) e só ids e a contagem — sem e-mail, IP ou user-agent
 * de quem clicou. A repetida não grava: nada mudou, e não há mutação a
 * auditar.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { registrarFalhaDeToken, tokenFailureLimited } from "@/lib/auth/rate-limit";
import { verifyCadenciaLink } from "@/lib/cadencias/token";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const CABECALHOS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const TENTE_DEPOIS = "Não foi possível processar agora. Tente de novo em alguns minutos.";
const SEM_REGISTRO = "Não foi possível registrar o descadastro por este link. Se continuar recebendo estes e-mails, responda a um deles pedindo para sair.";

/** O que `fn_cadencia_descadastrar` devolve quando gravou a supressão; null quando não achou o destinatário. */
const descadastroGravadoSchema = z.object({
  organization_id: z.string().uuid(),
  suprimido_agora: z.boolean(),
  inscricoes_paradas: z.number().int().min(0),
});

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
    const { data, error } = await admin.rpc("fn_cadencia_descadastrar", {
      p_destinatario_id: payload.destinatario_id,
    });
    if (error) {
      logger.error("[cadencia-descadastro] update falhou", { codigo: "cadencia_unsubscribe_write_failed" });
      return pagina(`<p>${TENTE_DEPOIS}</p>`, 503);
    }
    const gravado = descadastroGravadoSchema.safeParse(data);
    if (!gravado.success) {
      logger.warn("[cadencia-descadastro] destinatário não encontrado", { codigo: "cadencia_unsubscribe_recipient_missing" });
      return pagina(`<p>${SEM_REGISTRO}</p>`, 404);
    }

    const { organization_id, suprimido_agora, inscricoes_paradas } = gravado.data;
    if (suprimido_agora || inscricoes_paradas > 0) {
      await audit({
        action: "lgpd.consent_changed",
        organizationId: organization_id,
        resourceType: "email_cadence_recipient",
        resourceId: payload.destinatario_id,
        bypassedRls: true,
        metadata: { canal: "email_cadencia", consentimento: "revogado", origem: "link_descadastro", inscricoes_paradas },
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
