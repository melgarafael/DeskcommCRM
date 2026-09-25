import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/knowledge/reindex-all
 *
 * Reindexa TODOS os materiais ativos da organização de uma vez, emitindo
 * `knowledge_source.updated` por fonte (o worker re-processa; nada é apagado).
 *
 * Por que existe: depois de cadastrar a chave, ou de uma leva de materiais
 * que falhou, reindexar fonte a fonte numa loja com dezenas de materiais é onde
 * a pessoa desiste no meio. O worker PULA a fonte cujo conteúdo não mudou
 * (`content_hash`, migration 0409), então "Preparar tudo" não reembeda à toa.
 *
 * Auth: cookie session, role >= manager (o mesmo papel do reindexar de UMA
 * fonte). `organization_id` vem do JWT, nunca do corpo — e a rota não lê corpo
 * nenhum, então não há entrada externa para validar.
 *
 * Audita (`ai.knowledge_reindex_all`) quando há material; sem material não
 * houve mutação e não há o que auditar.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface FonteRow {
  id: string;
  agent_id: string | null;
  source_type: string;
  last_index_status: string | null;
}

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const { org, user } = authz;

  // RLS via cliente user-scoped; o filtro de organização é explícito e a fonte
  // é a sessão — nunca o corpo.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_knowledge_sources")
    .select("id, agent_id, source_type, last_index_status")
    .eq("organization_id", org.orgId)
    .neq("status", "archived");
  if (error) {
    logger.error("[ai-knowledge-reindex-all] falha ao listar os materiais", {
      error: error.message,
      requestId,
    });
    return fail("internal_error", "Erro ao listar os materiais.", 500, { requestId });
  }

  const fontes = (data ?? []) as FonteRow[];
  if (fontes.length === 0) {
    return ok({ total: 0, prioridade1: 0, prioridade2: 0, emitidos: 0 }, { requestId });
  }

  // PRIORIDADE: primeiro o que AINDA NÃO está pronto (nunca preparado,
  // falhou, sem credencial); depois o que já está `success` — que o worker PULA
  // se o conteúdo não mudou (hash) e o modelo é o mesmo. Assim "Preparar tudo"
  // não reembeda o que não mudou.
  const prioridade1 = fontes.filter((f) => f.last_index_status !== "success");
  const prioridade2 = fontes.filter((f) => f.last_index_status === "success");

  const admin = createAdminClient();
  // Limpa o erro anterior (o worker vai reescrever o estado). Não bloqueia: o
  // reprocessamento sobrescreve o erro de qualquer jeito.
  const { error: limparErr } = await admin
    .from("ai_knowledge_sources")
    .update({ last_index_error: null })
    .eq("organization_id", org.orgId)
    .neq("status", "archived");
  if (limparErr) {
    logger.warn("[ai-knowledge-reindex-all] não limpei o erro anterior dos materiais", {
      error: limparErr.message,
      requestId,
    });
  }

  let emitidos = 0;
  for (const f of [...prioridade1, ...prioridade2]) {
    const { error: emitErr } = await admin.rpc("emit_event" as never, {
      p_event_type: "knowledge_source.updated",
      p_entity_kind: "ai_knowledge_source",
      p_entity_id: f.id,
      p_payload: {
        knowledge_source_id: f.id,
        agent_id: f.agent_id,
        source_type: f.source_type,
        triggered_by: "manual_reindex_all",
      },
      p_organization_id: org.orgId,
    } as never);
    if (emitErr) {
      // Contado na resposta (`emitidos` < `total`) e registrado aqui: a fonte
      // que não entrou na fila é a que o dono vai achar que "não preparou".
      logger.warn("[ai-knowledge-reindex-all] evento de reindexação não emitido", {
        knowledge_source_id: f.id,
        error: emitErr.message,
        requestId,
      });
    } else {
      emitidos += 1;
    }
  }

  void audit({
    action: "ai.knowledge_reindex_all",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "ai_knowledge_source",
    requestId,
    metadata: {
      total: fontes.length,
      prioridade1: prioridade1.length,
      prioridade2: prioridade2.length,
      emitidos,
    },
  });

  return ok(
    {
      total: fontes.length,
      prioridade1: prioridade1.length,
      prioridade2: prioridade2.length,
      emitidos,
    },
    { requestId },
  );
}
