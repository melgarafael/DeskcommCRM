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
 * Auth: sessão por cookie OU token de servidor (`resolveAuthDual`), role >= manager
 * (o mesmo papel do reindexar de UMA fonte). `organization_id` vem da sessão ou
 * da linha do token, nunca do corpo — e a rota não lê corpo nenhum, então não há
 * entrada externa para validar.
 *
 * Audita (`ai.knowledge_reindex_all`) quando há material; sem material não
 * houve mutação e não há o que auditar.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { enfileirarTodosOsMateriais } from "@/lib/ai/knowledge/reprepara-tudo";
import { fail, ok } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_knowledge",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "ai_knowledge", requestId);
  if (teto) return teto;

  // O cliente do token é admin (sem RLS); quem protege é o filtro explícito de
  // organização dentro de `enfileirarTodosOsMateriais`, com a organização da
  // linha do token (ou da sessão) — nunca do corpo.
  let fila;
  try {
    fila = await enfileirarTodosOsMateriais({
      leitura: authz.supabase,
      admin: createAdminClient(),
      organizationId: authz.organizationId,
      requestId,
      motivo: "manual_reindex_all",
    });
  } catch (err) {
    logger.error("[ai-knowledge-reindex-all] falha ao listar os materiais", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", "Erro ao listar os materiais.", 500, { requestId });
  }

  if (fila.total > 0) {
    void audit({
      action: "ai.knowledge_reindex_all",
      actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
      actorApiTokenId: authz.apiTokenId ?? null,
      organizationId: authz.organizationId,
      resourceType: "ai_knowledge_source",
      requestId,
      metadata: { ...fila },
    });
  }

  return ok(fila, { requestId });
}
