/**
 * POST /api/v1/messages/{id}/retry — envia de novo uma mensagem que falhou, NA MESMA LINHA.
 *
 * A mesma linha, e não uma nova: uma linha nova desenharia uma segunda bolha e
 * dispararia de novo o que o INSERT dispara. Reaproveitar a linha passa pelo
 * caminho que o handler de envio já tem para isso (`internalMessageId`: o
 * INSERT colide, a linha `queued` é reaproveitada) e refaz TODAS as guardas
 * do envio — contato bloqueado, pessoal, canal arquivado ou desativado.
 *
 * O que impede o envio em dobro é a trava por `updated_at`: o UPDATE para
 * `queued` só pega se a linha ainda estiver exatamente como foi lida. Dois
 * toques simultâneos produzem um envio só, e um toque durante o envio cai em
 * "em voo" pela regra (`lib/messaging/reenvio.ts`), porque a trava adianta o
 * `updated_at` e tira o motivo da fila.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { estadoDaJanela } from "@/lib/channels/janela";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { reenvioDaMensagem } from "@/lib/messaging/reenvio";
import type { SendMessageInput } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface Ctx { params: Promise<{ id: string }> }

const corpoSchema = z.object({ confirmado: z.boolean().optional() });
const TETO_POR_USUARIO = 20;
const JANELA_SEGUNDOS = 60;

const COLUNAS =
  "id, organization_id, conversation_id, external_id, direction, type, status, error_code, error_message, body, media_storage_path, media_mime, media_size_bytes, reply_to_message_id, sent_via, sent_by_user_id, sent_at, metadata, updated_at";

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  // Autorização ANTES da validação: quem não pode enviar não aprende nada
  // sobre o formato do pedido.
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id } = await ctx.params;
  const corpo = corpoSchema.safeParse(await req.json().catch(() => ({})));
  if (!z.string().uuid().safeParse(id).success || !corpo.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  const teto = await checkRateLimit(`mensagem-reenvio:${authz.user.id}`, TETO_POR_USUARIO, JANELA_SEGUNDOS);
  if (!teto.allowed) {
    return fail("rate_limited", t("Muitas tentativas seguidas. Tente em um minuto."), 429, {
      requestId,
      headers: {
        "Retry-After": String(JANELA_SEGUNDOS),
        "X-RateLimit-Limit": String(teto.limit),
        "X-RateLimit-Remaining": String(Math.max(0, teto.limit - teto.count)),
      },
    });
  }

  const supabase = await createClient();
  const { data: lida, error: erroDaLeitura } = await supabase.from("messages").select(COLUNAS)
    .eq("id", id).eq("organization_id", orgId).maybeSingle();
  if (erroDaLeitura) return fail("internal_error", t("Erro ao buscar mensagem."), 500, { requestId });
  if (!lida) return fail("not_found", t("Mensagem não encontrada."), 404, { requestId });

  const tipo = reenvioDaMensagem(lida, {
    userId: authz.user.id,
    podeReenviarDeOutros: roleAtLeast(authz.org.role, "manager"),
  });
  if (tipo === "nenhum") {
    return fail("reenvio_indisponivel", t("Esta mensagem não pode ser reenviada."), 403, { requestId });
  }
  const confirmado = corpo.data.confirmado === true;
  if (tipo === "confirmar" && !confirmado) {
    return fail("confirmacao_necessaria", t("Confirme antes de enviar de novo."), 409, { requestId });
  }

  // O handler não confere a janela de 24h para envio humano (a tela já barra o
  // composer). Aqui não há composer: a conferência é desta rota.
  const { data: conversa } = await supabase.from("conversations")
    .select("id, last_inbound_at, channel_sessions:channel_session_id(provider)")
    .eq("id", lida.conversation_id).eq("organization_id", orgId).maybeSingle();
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  const sessao = conversa.channel_sessions as { provider?: string | null } | null;
  if (estadoDaJanela(sessao?.provider, conversa.last_inbound_at, new Date()).tipo === "fechada") {
    return fail("janela_fechada", t("A janela de 24 horas fechou. Envie um modelo aprovado ou aguarde o cliente escrever."), 422, { requestId });
  }

  const metadataSemMotivo = Object.fromEntries(
    Object.entries((lida.metadata ?? {}) as Record<string, unknown>).filter(([k]) => k !== "queued_reason"),
  );
  const { data: travada } = await supabase.from("messages")
    .update({
      status: "queued",
      error_code: null,
      error_message: null,
      // Sem id do canal enquanto está em voo: é assim que a ingestão reconhece o
      // eco deste envio (e não o lê como resposta digitada no celular). O envio
      // aceito grava o id novo; a recusa devolve o antigo.
      external_id: null,
      metadata: metadataSemMotivo,
    })
    .eq("id", id).eq("organization_id", orgId)
    .eq("status", lida.status).eq("updated_at", lida.updated_at)
    .select("id, updated_at").maybeSingle();
  if (!travada) {
    return fail("reenvio_em_curso", t("Esta mensagem já está sendo reenviada."), 409, { requestId });
  }

  const input: SendMessageInput = {
    conversation_id: lida.conversation_id,
    type: lida.type as SendMessageInput["type"],
    body: lida.body ?? undefined,
    media_storage_path: lida.media_storage_path ?? undefined,
    media_mime: lida.media_mime ?? undefined,
    media_size_bytes: lida.media_size_bytes ?? undefined,
    reply_to_message_id: lida.reply_to_message_id ?? undefined,
  };

  let message;
  try {
    message = await sendMessageHandler(supabase, {
      organization_id: orgId,
      actor: { type: "user", id: authz.user.id },
      requestId,
      idioma: authz.user.idioma,
      internalMessageId: id,
    }, input);
  } catch (err) {
    // Recusa ANTES de tocar na linha (contato bloqueado, pessoal, citação de
    // fora) ou erro inesperado: devolve o estado lido. Qualquer erro, e não só
    // `ApiError` — sem isto a linha ficava `queued` sem motivo, sem marca de
    // falha na tela. A mesma trava garante que, se o handler chegou a mexer na
    // linha, nada é desfeito por cima.
    await supabase.from("messages")
      .update({
        status: lida.status,
        external_id: lida.external_id,
        error_code: lida.error_code,
        error_message: lida.error_message,
        metadata: lida.metadata,
      })
      .eq("id", id).eq("organization_id", orgId)
      .eq("status", "queued").eq("updated_at", travada.updated_at);
    if (!(err instanceof ApiError)) throw err;
    return fail(err.code, err.message, err.status, { requestId });
  }

  // Só o envio ACEITO vai para o fim do fio: no WhatsApp do cliente ele chega
  // agora. O que ficou na fila ou falhou de novo não saiu, e mantém a hora e o
  // lugar de antes — senão cada toque com o canal caído mudaria a hora exibida.
  if (message.status !== "queued" && message.status !== "failed") {
    const agora = new Date().toISOString();
    const { error: erroAoMover } = await supabase.from("messages")
      .update({ sent_at: agora })
      .eq("id", id).eq("organization_id", orgId);
    if (!erroAoMover) message = { ...message, sent_at: agora };
  }

  await audit({
    action: "message.retried",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "message",
    resourceId: id,
    requestId,
    metadata: {
      message_id: id,
      status_anterior: lida.status,
      error_code_anterior: lida.error_code,
      sent_at_anterior: lida.sent_at,
      confirmado,
      status: message.status,
    },
  });
  return ok(message, { requestId });
}
