import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/transfer — reatribui a conversa a outro
 * atendente. Decisão G1-06d (spec 13 §5): transferência é IMEDIATA, sem etapa
 * de aceite do destino.
 *
 * G3-01: a mudança de dono acontece via rpc `fn_conversation_assign`
 * (migration 0031) — UPDATE de assigned_to_user_id + INSERT do evento
 * `reason='transfer'` em `conversation_assignment_events` na MESMA transação,
 * com `unread_count_for_assignee` re-zerado pro novo dono.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { sincronizarNegocioAbertoDoContato } from "@/lib/inbox/negocio-aberto-do-contato";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { transferConversationSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Conversation } from "@/lib/types/messaging";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const user = authz.user;
  const orgId = authz.org.orgId; // fonte confiável (cookie validado), nunca o body

  let input;
  try {
    input = await validateRequest(transferConversationSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Destino tem que ser membro ativo agent+ da MESMA org (a RLS de
  // user_organizations só mostra o próprio membership a um agent — por isso o
  // admin client, filtrado pela org resolvida acima).
  if (isServiceRoleConfigured()) {
    const admin = createAdminClient();
    const { data: member, error: memberErr } = await admin
      .from("user_organizations")
      .select("role")
      .eq("organization_id", orgId)
      .eq("user_id", input.to_user_id)
      .is("revoked_at", null)
      .maybeSingle();
    if (memberErr) {
      return fail("internal_error", memberErr.message, 500, { requestId });
    }
    if (!member || member.role === "viewer") {
      return fail("unprocessable_entity", t("Destino não é um atendente desta organização."), 422, {
        requestId,
      });
    }
  }

  // #3642 (doc 237, 2-A): o número em que a conversa estava ANTES da troca, para a
  // auditoria registrar o antigo e o novo — a RPC devolve só a linha depois.
  // Leitura pelo cliente da SESSÃO: é a mesma conversa que a RPC vai alcançar.
  // Se falhar, a transferência segue e a auditoria só não leva o par.
  const { data: antes } = await supabase
    .from("conversations")
    .select("channel_session_id")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  const numeroAnterior = (antes as { channel_session_id: string | null } | null)?.channel_session_id;

  const { data, error } = await supabase.rpc("fn_conversation_assign", {
    p_organization_id: orgId,
    p_conversation_id: id,
    p_to_user_id: input.to_user_id,
    p_reason: "transfer",
    // Imediata (G1-06d): sem optimistic lock — reatribui qualquer que seja o dono atual.
    p_enforce_expected: false,
  });

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  const row = data?.[0];
  if (!row) {
    return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  }

  const conv = row as unknown as Conversation;

  // #3177: o negócio ABERTO do contato segue o mesmo responsável. A conversa já
  // é do destino neste ponto; o card do funil não era, e ficava para trás (o
  // responsável antigo, ou nenhum). Cliente da SESSÃO de propósito: quem
  // transfere a conversa não ganha aqui nenhuma permissão que a rota de
  // negócios já não dê — quando o banco recusa, a transferência segue de pé e o
  // motivo fica no `metadata` da auditoria. Ver
  // `lib/inbox/negocio-aberto-do-contato.ts` para a régua (um aberto leva; zero
  // ou mais de um, nada é tocado).
  const sincronia = await sincronizarNegocioAbertoDoContato(supabase, {
    organizationId: conv.organization_id,
    contactId: conv.contact_id,
    toUserId: input.to_user_id,
  });

  await audit({
    action: "conversation.transferred",
    actorUserId: user.id,
    organizationId: conv.organization_id,
    resourceType: "conversation",
    resourceId: conv.id,
    requestId,
    metadata: {
      to_user_id: input.to_user_id,
      ...(input.reason ? { note: input.reason } : {}),
      negocio_aberto: sincronia.motivo,
      ...(sincronia.leadId ? { negocio_id: sincronia.leadId } : {}),
      // O número segue o vendedor (#3642): o antigo e o novo, iguais quando a
      // conversa ficou onde estava.
      ...(numeroAnterior !== undefined
        ? { numero_anterior: numeroAnterior, numero_novo: conv.channel_session_id }
        : {}),
    },
  });

  // Notificação ao destino (G1-06d): evento no bus; worker/Realtime consome.
  await supabase
    .rpc("emit_event", {
      p_event_type: "conversation.transferred",
      p_entity_kind: "conversation",
      p_entity_id: conv.id,
      p_payload: { assigned_to_user_id: input.to_user_id, transferred_by: user.id },
      p_metadata: { request_id: requestId },
      p_organization_id: conv.organization_id,
    })
    .then(({ error: emitErr }) => {
      if (emitErr) console.error("[conversation.transfer] emit_event failed", emitErr.message);
    });

  // O motivo que a pessoa escreveu ao transferir chega à TELA por aqui. Antes ele
  // ia só para `metadata` do audit log, cuja policy exige `admin` — ou seja,
  // sumia justamente para quem vai continuar o atendimento. O `reason` da
  // atividade é coberto pela cascata de anonimização da LGPD, que é o que
  // permite texto escrito por humano sobre um cliente morar ali.
  //
  // #3732: e a troca de número entra na MESMA linha. O #3658 gravava o par
  // antigo/novo só na auditoria da rota — o histórico da conversa, que é onde
  // quem atende olha, não dizia nada. Quando o número muda, a linha diz por qual
  // número a conversa continua, com o nome de quem atende; o par vai no payload
  // para a auditoria da atividade não depender de cruzar tabela.
  const trocouDeNumero =
    numeroAnterior !== undefined && numeroAnterior !== conv.channel_session_id;
  const continuacao = trocouDeNumero
    ? `Continua pelo número de ${conv.assigned_to_user_name?.trim() || "outro atendente"}`
    : null;
  await registrarTrocaDeComando({
    supabase,
    organizationId: conv.organization_id,
    conversationId: conv.id,
    contactId: conv.contact_id,
    tipo: "conversation_transferred",
    actor: { type: "user", id: user.id, role: authz.org.role },
    // Canônico em português: quem traduz é a LEITURA (`t(item.reason)`). Ver o
    // bloco "vocabulario de dominio persistido" em `lib/i18n/dicionario.ts`.
    motivo: [
      input.reason?.trim()
        ? `Transferiu a conversa: ${input.reason.trim()}`
        : "Transferiu a conversa para outro atendente",
      ...(continuacao ? [continuacao] : []),
    ].join(" · "),
    payload: {
      to_user_id: input.to_user_id,
      ...(continuacao
        ? {
            numero_anterior: numeroAnterior,
            numero_novo: conv.channel_session_id,
          }
        : {}),
    },
  });

  return ok(conv, { requestId });
}

const previaSchema = z.object({ to_user_id: z.string().uuid() });

/**
 * GET /api/v1/conversations/[id]/transfer?to_user_id=<uuid> — o aviso do diálogo
 * de Transferir (#3642, doc 237, escolha 2-A): por qual número a conversa vai
 * continuar se for transferida para essa pessoa. `numero: null` = ela fica no
 * número em que está.
 *
 * A resposta vem da MESMA função que a troca aplica
 * (`fn_numero_da_transferencia`, migration 9039) — o aviso nunca diz um número
 * enquanto a transferência grava outro. Só leitura: nada muda aqui.
 */
export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId; // fonte confiável (cookie validado), nunca a query

  const parsed = previaSchema.safeParse({ to_user_id: req.nextUrl.searchParams.get("to_user_id") });
  if (!parsed.success) {
    return fail("invalid_request", t("Destino inválido."), 400, { requestId });
  }

  // Quem pergunta precisa enxergar a conversa: a leitura é pelo cliente da
  // SESSÃO, com a RLS de sempre. Só depois o admin responde a regra.
  const supabase = await createClient();
  const { data: conversa, error: erroConversa } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (erroConversa) return fail("internal_error", erroConversa.message, 500, { requestId });
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  if (!isServiceRoleConfigured()) return ok({ numero: null }, { requestId });

  const admin = createAdminClient();
  const { data: numeroId, error: erroNumero } = await admin.rpc("fn_numero_da_transferencia", {
    p_organization_id: orgId,
    p_conversation_id: id,
    p_to_user_id: parsed.data.to_user_id,
  });
  if (erroNumero) return fail("internal_error", erroNumero.message, 500, { requestId });
  if (!numeroId) return ok({ numero: null }, { requestId });

  const { data: sessao, error: erroSessao } = await admin
    .from("channel_sessions")
    .select("id, display_name, phone_number")
    .eq("organization_id", orgId)
    .eq("id", numeroId as string)
    .maybeSingle();
  if (erroSessao) return fail("internal_error", erroSessao.message, 500, { requestId });

  const linha = sessao as { id: string; display_name: string | null; phone_number: string | null } | null;
  return ok(
    {
      numero: {
        channel_session_id: numeroId as string,
        display_name: linha?.display_name ?? null,
        phone_number: linha?.phone_number ?? null,
      },
    },
    { requestId },
  );
}
