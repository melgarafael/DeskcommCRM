/**
 * Põe TODO material ativo da organização na fila do indexador.
 *
 * Dois chamadores: "Preparar tudo de novo" (`POST /api/v1/ai/knowledge/reindex-all`)
 * e a troca de provedor da base (`PUT /api/v1/ai/knowledge/provedor`). Na troca,
 * refazer a base NÃO é opcional — a busca só compara com trechos do mesmo modelo,
 * e até o indexador passar o agente não acha o material calculado pelo outro.
 * Por isso a fila sai no mesmo pedido que troca o provedor, e não num segundo
 * clique que a pessoa poderia não dar.
 *
 * Emite `knowledge_source.updated` por fonte (nada é apagado). O worker pula a
 * fonte cujo conteúdo E modelo não mudaram (`content_hash`, migration 0409).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

interface FonteRow {
  id: string;
  agent_id: string | null;
  source_type: string;
  last_index_status: string | null;
}

const PAGE_SIZE = 500;

export interface ResultadoDaFila {
  total: number;
  prioridade1: number;
  prioridade2: number;
  emitidos: number;
}

export async function enfileirarTodosOsMateriais(p: {
  /** Cliente da sessão: a listagem passa pela RLS. */
  leitura: SupabaseClient;
  /** Service role: emitir evento e limpar o erro anterior. Filtro de org explícito. */
  admin: SupabaseClient;
  organizationId: string;
  requestId: string;
  motivo: "manual_reindex_all" | "troca_de_provedor";
}): Promise<ResultadoDaFila> {
  const fontes: FonteRow[] = [];
  let depois: string | null = null;
  for (;;) {
    let consulta = p.leitura
      .from("ai_knowledge_sources")
      .select("id, agent_id, source_type, last_index_status")
      .eq("organization_id", p.organizationId)
      .neq("status", "archived")
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (depois) consulta = consulta.gt("id", depois);
    const { data, error } = await consulta;
    if (error) {
      throw new Error(`listar_materiais_falhou: ${error.message}`);
    }
    const pagina = (data ?? []) as FonteRow[];
    // Only an empty page proves completion: the API may cap rows below PAGE_SIZE.
    if (pagina.length === 0) break;
    fontes.push(...pagina);
    depois = pagina[pagina.length - 1]!.id;
  }

  if (fontes.length === 0) {
    return { total: 0, prioridade1: 0, prioridade2: 0, emitidos: 0 };
  }

  // PRIORIDADE: primeiro o que AINDA NÃO está pronto (nunca preparado,
  // falhou, sem credencial); depois o que já está `success` — que o worker PULA
  // se o conteúdo não mudou (hash) e o modelo é o mesmo. Assim "Preparar tudo"
  // não reembeda o que não mudou.
  const prioridade1 = fontes.filter((f) => f.last_index_status !== "success");
  const prioridade2 = fontes.filter((f) => f.last_index_status === "success");

  // Limpa o erro anterior (o worker vai reescrever o estado). Não bloqueia: o
  // reprocessamento sobrescreve o erro de qualquer jeito.
  const { error: limparErr } = await p.admin
    .from("ai_knowledge_sources")
    .update({ last_index_error: null })
    .eq("organization_id", p.organizationId)
    .neq("status", "archived");
  if (limparErr) {
    logger.warn("[ai-knowledge-reindex-all] não limpei o erro anterior dos materiais", {
      error: limparErr.message,
      requestId: p.requestId,
    });
  }

  let emitidos = 0;
  for (const f of [...prioridade1, ...prioridade2]) {
    const { error: emitErr } = await p.admin.rpc("emit_event" as never, {
      p_event_type: "knowledge_source.updated",
      p_entity_kind: "ai_knowledge_source",
      p_entity_id: f.id,
      p_payload: {
        knowledge_source_id: f.id,
        agent_id: f.agent_id,
        source_type: f.source_type,
        triggered_by: p.motivo,
      },
      p_organization_id: p.organizationId,
    } as never);
    if (emitErr) {
      // Contado na resposta (`emitidos` < `total`) e registrado aqui: a fonte
      // que não entrou na fila é a que o dono vai achar que "não preparou".
      logger.warn("[ai-knowledge-reindex-all] evento de reindexação não emitido", {
        knowledge_source_id: f.id,
        error: emitErr.message,
        requestId: p.requestId,
      });
    } else {
      emitidos += 1;
    }
  }

  return {
    total: fontes.length,
    prioridade1: prioridade1.length,
    prioridade2: prioridade2.length,
    emitidos,
  };
}
