/**
 * GET /api/v1/mensagens-agendadas/ocorrencias?conversation_id=…  — o histórico de
 *     ocorrências de uma série (ou de todas as séries) que a sessão enxerga.
 *
 * Segunda parte da #3118 (repetição). Lido pelo cliente de SESSÃO: a policy de
 * `mensagens_agendadas_envios` confere a conversa pela RLS dela, então a leitura
 * segue a mesma régua da caixa de entrada. Nunca o `service_role` aqui.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { paginaDaConsulta, temMaisPagina } from "@/lib/agendamento-mensagem/lista";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, agendamento_id, conversation_id, prevista_para, status, motivo, message_id, created_at, agendamento:mensagens_agendadas(title, body, recorrencia, intervalo_dias), mensagem:messages(status)";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;
  const parametros = req.nextUrl.searchParams;
  const conversationId = parametros.get("conversation_id");
  if (conversationId !== null && !z.uuid().safeParse(conversationId).success) {
    return fail("validation_failed", "conversation_id inválido.", 422, { requestId });
  }
  const { limite, deslocamento } = paginaDaConsulta(parametros);

  const sessao = await createClient();
  let consulta = sessao
    .from("mensagens_agendadas_envios")
    .select(COLUNAS, { count: "exact" })
    .eq("organization_id", auth.org.orgId)
    .order("prevista_para", { ascending: false })
    .range(deslocamento, deslocamento + limite - 1);
  if (conversationId !== null) consulta = consulta.eq("conversation_id", conversationId);

  const { data, error, count } = await consulta;
  if (error) return fail("internal_error", "Erro ao listar ocorrências.", 500, { requestId });
  const linhas = data ?? [];
  return ok(linhas, {
    requestId,
    meta: {
      total: count ?? null,
      limit: limite,
      offset: deslocamento,
      has_more: temMaisPagina(deslocamento, linhas.length, count ?? null, limite),
    },
  });
}
