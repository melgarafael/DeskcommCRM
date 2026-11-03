/**
 * GET /api/v1/cron/mcp-oauth-revogacao
 *
 * Revoga no terceiro (RFC 7009) as credenciais OAuth por contato cuja
 * revogação já venceu — agendada pelo encerramento da conversa (com a retenção
 * do servidor) ou pela anonimização do contato (imediata, e a linha é apagada).
 * Os gatilhos da migration 9095 só gravam `revogar_apos`; trigger não faz HTTP,
 * e é esta rodada que fala com o authorization server. Um lote por chamada,
 * idempotente: credencial revogada não é escolhida de novo. Cada revogação
 * audita (`contact.mcp_acesso_revogado`) dentro de `revogarVencidas`; rodada
 * vazia não audita nada.
 *
 * NÃO consulta o módulo opcional `mcp_por_agente` (doc 252), de propósito.
 * Desligar o módulo para de USAR o acesso; não pode deixar de DEVOLVÊ-LO. Um
 * contato anonimizado com o módulo desligado ficaria com o token vivo no
 * terceiro até alguém religar. Numa instalação que nunca ligou, a tabela está
 * vazia e a rodada é uma leitura que não acha nada, sem rede e sem auditoria.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { revogarVencidas } from "@/lib/mcp/servidor-externo/do-agente/revogacao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  try {
    const resultado = await revogarVencidas(createAdminClient());
    return ok(resultado, { requestId });
  } catch (err) {
    logger.error("[mcp-oauth-revogacao] a rodada falhou", {
      request_id: requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "A rodada de revogação falhou.", 500, { requestId });
  }
}
