/**
 * GET /api/v1/voice/calls/history — histórico de chamadas da organização.
 *
 * Lê de `voice_calls` (a NOSSA cópia, sincronizada pela ponte de eventos do
 * worker — §4.2 da spec), não faz proxy pro `/history` do WaCalls: nossa
 * tabela já tem `contact_id`/`end_reason` que o upstream não devolve.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "voice_calls" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? "50") || 50, 200);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("voice_calls")
    .select(
      "id, contact_id, direction, peer_phone, status, end_reason, started_at, answered_at, ended_at, duration_ms, owner_user_id, created_by",
    )
    .eq("organization_id", activeOrg.orgId)
    .order("started_at", { ascending: false })
    .limit(limit);

  // ERRO NÃO É LISTA VAZIA.
  //
  // `ok([])` fazia "a consulta falhou" ficar indistinguível de "esta
  // organização nunca ligou para ninguém" — e a segunda frase é a que a tela
  // conta. Além de esconder a falha, é o desfecho que convida alguém a concluir
  // que o histórico se perdeu. Falhar ABERTO na informação, sempre.
  if (error) {
    logger.error("voice: histórico de chamadas falhou", {
      request_id: requestId,
      organization_id: activeOrg.orgId,
      error: error.message,
    });
    return fail("internal_error", error.message, 500, { requestId });
  }
  return ok(data ?? [], { requestId, meta: { has_more: (data?.length ?? 0) === limit } });
}
