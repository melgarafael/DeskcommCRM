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
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { logger } from "@/lib/logger";
import { revogarVencidas } from "@/lib/mcp/servidor-externo/do-agente/revogacao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO (#3773), na ordem do arquivo.
 *
 * O portão abaixo é saída antecipada da ROTA INTEIRA: em instalação ociosa a
 * rota sai antes de tudo isto. `tests/unit/cron-passa-pelo-portao.test.ts` lê o
 * AST deste arquivo e reprova quando o que está de fato abaixo do portão diverge
 * desta lista — passo novo que não roda na instalação parada não pode nascer
 * sem alguém ver.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "try",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  // O PISO OCIOSO (#3731): Sem credencial vencida não há revogação a fazer no terceiro.
  // A saída vem antes de qualquer consulta da rodada, e o portão responde de um
  // retrato em memória (`lib/cron/piso-ocioso.ts`): esta rota ia ao PostgREST a
  // cada batida só para descobrir que a fila está vazia.
  if (await recursoOcioso("mcp_a_revogar")) return ok({ pulado: "recurso_ocioso" }, { requestId });

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
