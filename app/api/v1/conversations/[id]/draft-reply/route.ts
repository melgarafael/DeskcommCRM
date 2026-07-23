/**
 * POST /api/v1/conversations/:id/draft-reply — sugere um rascunho de resposta
 * pra o composer (sob demanda, sem enviar nada). Onda 5.1.
 *
 * Reusa `generateDraftReply` (agent-engine) via um pool de Postgres próprio
 * do processo Next.js — sem tools, sem guardrails de envio (revisão humana
 * antes de sair). Sem rate-limiter dedicado: `assertBudget` dentro de
 * `runModelCall` já limita custo por org.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { generateDraftReply, type DraftReplyResult } from "@/lib/agent-engine/agent/draft-reply";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { crmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/crm/mcp-client";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/run-model-call";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const REASON_TO_RESPONSE: Record<
  Exclude<DraftReplyResult, { ok: true }>["reason"],
  [code: string, message: string, status: number]
> = {
  no_agent: ["no_agent", "Nenhum agente publicado para sugerir resposta.", 422],
  blocked: ["blocked", "Contato bloqueado/anonimizado.", 422],
  empty: ["empty", "A IA não gerou um rascunho.", 422],
  error: ["internal_error", "Erro ao gerar rascunho.", 500],
};

export async function POST(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, organization_id, contact_id, channel_session_id, status")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conv) return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  if (!conv.contact_id || !conv.channel_session_id) {
    return fail("unprocessable", "Conversa sem contato/canal.", 422, { requestId });
  }

  let pool;
  try {
    pool = getRequestPool();
  } catch {
    return fail("unavailable", "Rascunho da IA indisponível (config).", 503, { requestId });
  }

  // Falha controlada (getLeadContext ok:false) volta como reason:'error' e vira
  // 500 abaixo. Exceção inesperada (credencial inválida, provider fora, pool
  // morto, assertBudget) NÃO é engolida: sobe pro handler global do Next, que a
  // registra — perder a causa raiz de uma chamada de LLM seria cegueira em prod.
  const result: DraftReplyResult = await generateDraftReply(
    pool,
    llmEdgeConfigFromEnv(env),
    crmEdgeConfigFromEnv({
      SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    }),
    {
      tenantId: org.orgId,
      leadId: conv.contact_id,
      conversationId: conv.id,
      channelSessionId: conv.channel_session_id,
    },
  );

  if (!result.ok) {
    const [code, message, status] = REASON_TO_RESPONSE[result.reason];
    return fail(code, message, status, { requestId });
  }
  return ok({ draft: result.draft }, { requestId });
}
