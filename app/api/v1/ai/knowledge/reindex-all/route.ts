import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/knowledge/reindex-all
 *
 * Reindexa TODOS os materiais ativos da organização de uma vez, emitindo
 * `knowledge_source.updated` por fonte (o worker re-processa; nada é apagado).
 *
 * Por que existe: quando o dono troca a chave/provedor de embedding, o material
 * antigo fica com vetores de OUTRO modelo — a busca casa o `embedding_model`
 * gravado na versão (migration 0181) e devolve vazio. Reindexar fonte a fonte
 * numa loja com dezenas de materiais é onde a pessoa desiste no meio.
 *
 * Auth: cookie session, role >= manager. `organization_id` vem do JWT, nunca do
 * corpo.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
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
  const { org } = authz;

  // RLS via cliente user-scoped; o filtro de organização é explícito e a fonte
  // é a sessão — nunca o corpo.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_knowledge_sources")
    .select("id, agent_id, source_type, last_index_status")
    .eq("organization_id", org.orgId)
    .neq("status", "archived");
  if (error) {
    return fail("internal_error", "Erro ao listar os materiais.", 500, { requestId });
  }

  const fontes = (data ?? []) as FonteRow[];
  if (fontes.length === 0) {
    return ok({ total: 0, prioridade1: 0, prioridade2: 0, emitidos: 0 }, { requestId });
  }

  // PRIORIDADE (C-065): primeiro o que AINDA NÃO está pronto (nunca preparado,
  // falhou, sem credencial); depois o que já está `success` — que o worker PULA
  // se o conteúdo não mudou (hash) e o modelo é o mesmo. Assim "Preparar tudo"
  // não reembeda o que não mudou.
  const prioridade1 = fontes.filter((f) => f.last_index_status !== "success");
  const prioridade2 = fontes.filter((f) => f.last_index_status === "success");

  const admin = createAdminClient();
  // Limpa o erro anterior (o worker vai reescrever o estado).
  await admin
    .from("ai_knowledge_sources")
    .update({ last_index_error: null })
    .eq("organization_id", org.orgId)
    .neq("status", "archived");

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
    if (!emitErr) emitidos += 1;
  }

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
