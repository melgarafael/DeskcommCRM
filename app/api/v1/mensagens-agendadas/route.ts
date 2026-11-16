/**
 * GET  /api/v1/mensagens-agendadas?conversation_id=…  — os agendamentos da conversa
 *      (pendentes e os que já tiveram desfecho), com o status da mensagem enviada.
 * GET  /api/v1/mensagens-agendadas?limit=…&offset=…   — os envios de TODAS as
 *      conversas que a sessão enxerga ("Exibir todos"), paginados.
 * POST /api/v1/mensagens-agendadas                    — agenda um texto nesta conversa.
 *
 * Primeira parte da #3118: envio único, só nas conversas que o atendente já
 * enxerga. A leitura é pela SESSÃO: a policy de `mensagens_agendadas` exige a
 * conversa visível, então vale a mesma régua da caixa de entrada. A escrita é do
 * servidor, depois de a sessão provar que enxerga a conversa.
 *
 * Segunda parte (recorte do "Exibir todos"): sem `conversation_id` a rota lista
 * a empresa pelas conversas visíveis — a RLS continua sendo a régua, e o filtro
 * NÃO é por autor: o gestor vê o envio agendado por outro atendente.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { criarAgendamentoSchema, horarioNoFuturo } from "@/lib/agendamento-mensagem/schema";
import { listarAgendamentosVisiveis, paginaDaConsulta, temMaisPagina } from "@/lib/agendamento-mensagem/lista";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, conversation_id, title, body, scheduled_at, status, se_desconectado, motivo, created_at, mensagem:messages(status)";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;
  const sessao = await createClient();
  const parametros = req.nextUrl.searchParams;
  const conversationId = parametros.get("conversation_id");

  // "Exibir todos": sem conversa no pedido, a lista cruza a empresa pelas
  // conversas que a sessão enxerga (a RLS de `mensagens_agendadas`).
  if (conversationId === null) {
    const { limite, deslocamento } = paginaDaConsulta(parametros);
    const { linhas, total, erro } = await listarAgendamentosVisiveis(sessao, {
      organizationId: auth.org.orgId,
      limite,
      deslocamento,
    });
    if (erro) return fail("internal_error", "Erro ao listar agendamentos.", 500, { requestId });
    return ok(linhas, {
      requestId,
      meta: {
        total,
        limit: limite,
        offset: deslocamento,
        has_more: temMaisPagina(deslocamento, linhas.length, total, limite),
      },
    });
  }

  if (!z.uuid().safeParse(conversationId).success) {
    return fail("validation_failed", "conversation_id inválido.", 422, { requestId });
  }
  const { data, error } = await sessao
    .from("mensagens_agendadas")
    .select(COLUNAS)
    .eq("organization_id", auth.org.orgId)
    .eq("conversation_id", conversationId)
    .order("scheduled_at", { ascending: false })
    .limit(50);
  if (error) return fail("internal_error", "Erro ao listar agendamentos.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;

  const parsed = criarAgendamentoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira os campos do agendamento.", 422, {
      requestId,
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const v = parsed.data;
  if (!horarioNoFuturo(v.scheduled_at)) {
    return fail("validation_failed", "Escolha um horário no futuro.", 422, { requestId, details: { motivo: "horario_no_passado" } });
  }
  const orgId = auth.org.orgId;

  // A sessão enxerga a conversa? A RLS de `conversations` decide; contato e
  // número saem daqui, nunca do corpo.
  const sessao = await createClient();
  const { data: conversa, error: convErr } = await sessao
    .from("conversations")
    .select("id, contact_id, channel_session_id")
    .eq("id", v.conversation_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", "Erro ao ler a conversa.", 500, { requestId });
  if (!conversa?.contact_id || !conversa.channel_session_id) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const { data: criado, error } = await createAdminClient()
    .from("mensagens_agendadas")
    .insert({
      organization_id: orgId,
      conversation_id: conversa.id,
      contact_id: conversa.contact_id,
      channel_session_id: conversa.channel_session_id,
      title: v.title ?? null,
      body: v.body,
      scheduled_at: v.scheduled_at,
      se_desconectado: v.se_desconectado,
      created_by_user_id: auth.user.id,
    })
    .select("id, scheduled_at, status")
    .single();
  if (error || !criado) return fail("internal_error", "Não consegui criar o agendamento.", 500, { requestId });

  void audit({
    action: "scheduled_message.created",
    organizationId: orgId,
    actorUserId: auth.user.id,
    resourceType: "mensagens_agendadas",
    resourceId: criado.id,
    requestId,
    metadata: { conversation_id: conversa.id, scheduled_at: v.scheduled_at },
  });
  return ok(criado, { requestId });
}
