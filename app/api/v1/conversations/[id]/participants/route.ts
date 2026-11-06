import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * /api/v1/conversations/[id]/participants — o ATENDIMENTO CONJUNTO (issue #2542).
 *
 * O dono único (`assigned_to_user_id`) continua sendo quem FECHA e TRANSFERE.
 * Esta rota NÃO é dono: quem entra como participante LÊ e RESPONDE sem roubar
 * a conversa — entrar não é assumir. É o cenário que a transferência não cobre:
 * o N1 continua respondendo enquanto o N2 entra, e o comercial não sai do meio
 * da negociação quando o técnico chega.
 *
 *   GET    → quem participa (a tela do dono lê a lista)
 *   POST   → convida um colega (corpo: `{ user_id }`)
 *   DELETE → remove participante, ou a PRÓPRIA saída (corpo: `{ user_id }`)
 *
 * Quem pode convidar/remover: o DONO da conversa ou um GESTOR (ou acima). A
 * checagem de "gestor ou acima" é o `requireRole` canônico — nenhuma rota deste
 * repo compara rank na mão (anti-padrão "matriz advisória"), e a segunda
 * chamada só acontece quando o chamador NÃO é o dono.
 *
 * ─── Quem pode LER a lista: a RLS, não uma porta auditada ──────────────────
 *
 * No GET NÃO há `requireRole`. Ele audita a negação (`authz.denied` em
 * `lib/auth/require-role.ts`) e a leitura da lista não é decisão de papel: quem
 * decide quem vê a conversa é a RLS de `conversations` — `fn_can_view_conversation`
 * MAIS o ramo do participante (migration 0661). Ler a conversa pelo cliente de
 * SESSÃO (o mesmo `getConversationHandler` do `GET /conversations/[id]`) faz a
 * régua da lista ser exatamente a régua da conversa: "quem vê a conversa vê quem
 * participa". Sem isto, quem LEGITIMAMENTE enxerga a conversa mas não é dono,
 * participante nem gestor — o `agent` da fila sem dono (visibility_mode default
 * `own_and_unassigned`) e o `viewer` (leitura org-wide) — gravava um
 * `authz.denied` FALSO a cada abertura. É a mesma classe de ruído que foi tirada
 * do GET em 15/10; aqui sai a porta inteira. Convite/remoção (POST/DELETE)
 * continuam no `requireRole("manager")`: lá a negação É de verdade e merece
 * auditoria.
 *
 * O convite é INTERNO do começo ao fim: nada sai para o canal do cliente —
 * a mesma régua das notas internas. A escrita vai pelo service role porque a
 * tabela é SERVER-ONLY (RLS sem policy de INSERT): um vínculo forjado pela
 * sessão diria que alguém participa de uma conversa que nunca foi convidado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { requireRole, orgAtivaDaApi } from "@/lib/auth/require-role";
import { loadAuthUser } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  convidarParticipanteSchema,
  removerParticipanteSchema,
  validateRequest,
} from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * As colunas de conversa que a autorização usa, e SÓ elas. `assigned_to_user_id`
 * é o dono — a régua de "dono da conversa"; `organization_id` é o filtro de
 * tenant da leitura (a RLS isola, mas o filtro explícito é defesa em
 * profundidade, o mesmo da rota de transferência).
 */
const COLUNAS_DA_CONVERSA = "id, organization_id, contact_id, assigned_to_user_id, contacts:contact_id(is_personal)";

function ehConversaPessoal(conversa: unknown): boolean {
  return (conversa as { contacts?: { is_personal?: boolean } | null }).contacts?.is_personal === true;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  // SEM `requireRole` aqui: ele audita a negação, e a leitura da lista não é
  // decisão de papel — quem decide é a RLS de `conversations` (cabeçalho).
  const user = await loadAuthUser();
  if (!user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const t = (texto: string) => traduzir(texto, user.idioma);
  const ativa = await orgAtivaDaApi(user, requestId);
  if (!ativa.ok) return ativa.response;
  const orgId = ativa.org?.orgId;
  if (!orgId) {
    return fail("no_active_org", t("No active organization."), 403, { requestId });
  }
  if (!z.uuid().safeParse(id).success) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  if (!isServiceRoleConfigured()) {
    return fail("internal_error", t("Serviço indisponível no momento."), 503, { requestId });
  }
  const admin = createAdminClient();

  // "Quem vê a conversa vê quem participa": a conversa é lida pelo cliente de
  // SESSÃO — a MESMA RLS do `GET /conversations/[id]` (`fn_can_view_conversation`
  // + o ramo do participante da migration 0661). Sem visibilidade a RLS devolve
  // nada e a resposta é o mesmo 404 do inexistente: não revela que ela existe.
  const supabase = await createClient();
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select(COLUNAS_DA_CONVERSA)
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!conv || ehConversaPessoal(conv)) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const { data: participantes, error } = await admin
    .from("conversation_participants")
    .select("id, user_id, invited_by, joined_at")
    .eq("organization_id", orgId)
    .eq("conversation_id", id)
    .is("left_at", null)
    .order("joined_at", { ascending: true });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok({ participantes: participantes ?? [] }, { requestId });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const user = authz.user;
  const orgId = authz.org.orgId;
  if (!z.uuid().safeParse(id).success) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  let input;
  try {
    input = await validateRequest(convidarParticipanteSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  if (!isServiceRoleConfigured()) {
    return fail("internal_error", t("Serviço indisponível no momento."), 503, { requestId });
  }
  const admin = createAdminClient();

  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select(COLUNAS_DA_CONVERSA)
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!conv || ehConversaPessoal(conv)) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  // Convida o DONO da conversa ou um gestor. A segunda chamada ao `requireRole`
  // é o caminho canônico de "manager ou acima" — nada de comparar rank aqui.
  if (conv.assigned_to_user_id !== user.id) {
    const gestor = await requireRole("manager", { requestId, resource: "conversations" });
    if (!gestor.ok) {
      return fail(
        "forbidden_role",
        t("Só o responsável pela conversa ou um gestor pode convidar colegas."),
        403,
        { requestId },
      );
    }
  }

  // O convidado tem de ser membro ativo `agent`+ da MESMA organização. A RLS de
  // `user_organizations` só mostra o próprio vínculo a um agent — por isso o
  // admin client, filtrado pela org resolvida e pelo `revoked_at`.
  const { data: membro, error: membroErr } = await admin
    .from("user_organizations")
    .select("role")
    .eq("organization_id", orgId)
    .eq("user_id", input.user_id)
    .is("revoked_at", null)
    .maybeSingle();
  if (membroErr) return fail("internal_error", membroErr.message, 500, { requestId });
  if (!membro || membro.role === "viewer") {
    return fail("unprocessable_entity", t("Destino não é um atendente desta organização."), 422, {
      requestId,
    });
  }

  // `upsert` no vínculo único (conversation_id, user_id): reentrar LIMPA o
  // `left_at` em vez de criar segunda linha. NÃO toca `conversations`.
  const { data, error } = await admin
    .from("conversation_participants")
    .upsert(
      {
        organization_id: orgId,
        conversation_id: id,
        user_id: input.user_id,
        invited_by: user.id,
        joined_at: new Date().toISOString(),
        left_at: null,
      },
      { onConflict: "conversation_id,user_id" },
    )
    .select("id, user_id, invited_by, joined_at, left_at")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "conversation.invited",
    actorUserId: user.id,
    organizationId: orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
    metadata: { participant_user_id: input.user_id },
  });

  return ok({ participante: data }, { requestId, status: 201 });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const user = authz.user;
  const orgId = authz.org.orgId;
  if (!z.uuid().safeParse(id).success) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  let input;
  try {
    input = await validateRequest(removerParticipanteSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  if (!isServiceRoleConfigured()) {
    return fail("internal_error", t("Serviço indisponível no momento."), 503, { requestId });
  }
  const admin = createAdminClient();

  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select(COLUNAS_DA_CONVERSA)
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", convErr.message, 500, { requestId });
  if (!conv || ehConversaPessoal(conv)) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  // Sair da conversa é de quem participa; REMOVER um colega é do dono ou de um
  // gestor. O `user_id` do corpo decide o caso.
  const saida = input.user_id === user.id;
  if (!saida && conv.assigned_to_user_id !== user.id) {
    const gestor = await requireRole("manager", { requestId, resource: "conversations" });
    if (!gestor.ok) {
      return fail(
        "forbidden_role",
        t("Só o responsável pela conversa ou um gestor pode remover participantes."),
        403,
        { requestId },
      );
    }
  }

  // Soft delete: `left_at` tira o ACESSO (o `exists` da policy de conversas
  // filtra `left_at is null`) sem apagar o fato de a participação ter existido.
  const { data: encerradas, error } = await admin
    .from("conversation_participants")
    .update({ left_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("conversation_id", id)
    .eq("user_id", input.user_id)
    .is("left_at", null)
    .select("id");
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const removidos = encerradas?.length ?? 0;
  if (removidos > 0) {
    await audit({
      action: "conversation.participant_removed",
      actorUserId: user.id,
      organizationId: orgId,
      resourceType: "conversation",
      resourceId: id,
      requestId,
      metadata: { participant_user_id: input.user_id, saiu_sozinho: saida },
    });
  }

  return ok({ removidos }, { requestId });
}
