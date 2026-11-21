import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { liberarDaQuarentena } from "@/lib/entrada/quarentena";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/v1/quarentena/[id]/liberar — a pessoa da equipe libera a mensagem
 * retida pelo filtro de spam (#4026).
 *
 * ## O QUE A LIBERAÇÃO FAZ, E O QUE ELA NÃO FAZ
 *
 * Ela NÃO move, NÃO reenvia e NÃO recoloca a mensagem: a linha em `messages`
 * sempre esteve lá, íntegra. O que acontece é o que ficou pendente — os mesmos
 * efeitos de qualquer entrada (`aplicarEfeitosPosEntrada`, a única função que
 * transforma mensagem em trabalho): opt-out respeitado, demanda no funil,
 * campanha, follow-up e o turno do agente, agora ATRASADO pelo tempo da fila e
 * não perdido. É por isso que a liberação reusa a função de produção em vez de
 * montar um caminho paralelo: um segundo caminho divergiria do primeiro na
 * primeira mudança de qualquer um deles.
 *
 * ## Duas liberações não duplicam trabalho
 *
 * O UPDATE da quarentena é um CAS em `status = 'em_quarentena'`
 * (`liberarDaQuarentena`): o segundo clique recebe 409 e os efeitos rodam UMA
 * vez. Sem o CAS, dois atendentes clicando juntos abririam duas demandas e
 * pediriam dois turnos para a mesma mensagem.
 */

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  // Guarda de EFEITO antes de qualquer cliente privilegiado: em acompanhamento
  // administrativo só leitura, liberar mensagem é escrita e não pode passar.
  const support = await requireSupportWrite();
  if (support) return support;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "quarentena" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const admin = createAdminClient();
  const desfecho = await liberarDaQuarentena(admin, {
    organizationId: authz.org.orgId,
    id,
    userId: authz.user.id,
  });
  if (!desfecho.ok) {
    if (desfecho.motivo === "nao_encontrada") {
      return fail("not_found", t("Mensagem retida não encontrada."), 404, { requestId });
    }
    if (desfecho.motivo === "ja_liberada") {
      return fail("conflict", t("Esta mensagem já foi liberada."), 409, { requestId });
    }
    return fail("internal_error", t("Não foi possível liberar a mensagem."), 500, { requestId });
  }

  const linha = desfecho.linha;
  const { data: mensagem } = await admin
    .from("messages")
    .select("body, direction")
    .eq("id", linha.message_id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const corpo = (mensagem as { body?: string | null } | null)?.body ?? null;

  // Os efeitos de sempre, agora. Falha aqui NÃO volta atrás na liberação (a
  // linha está liberada e a mensagem continua íntegra): fica no log para ser
  // reprocessada, que é o mesmo desfecho da ingestão normal quando um efeito
  // falha.
  try {
    await aplicarEfeitosPosEntrada(admin, {
      organizationId: authz.org.orgId,
      contactId: linha.contact_id ?? "",
      conversationId: linha.conversation_id,
      messageId: linha.message_id,
      channelSessionId: linha.channel_session_id ?? "",
      texto: corpo,
      nomeDoContato: null,
      origem: "quarentena_liberada",
      requestId,
    });
  } catch (erro) {
    logger.error("[quarentena] efeitos da liberação falharam", {
      organization_id: authz.org.orgId,
      quarentena_id: linha.id,
      message_id: linha.message_id,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
  }

  await audit({
    action: "quarentena.mensagem_liberada",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "quarentena_de_entrada",
    resourceId: linha.id,
    requestId,
    metadata: { message_id: linha.message_id, conversation_id: linha.conversation_id },
  });

  return ok({ liberada: true, mensagem_id: linha.message_id, conversa_id: linha.conversation_id }, { requestId });
}
