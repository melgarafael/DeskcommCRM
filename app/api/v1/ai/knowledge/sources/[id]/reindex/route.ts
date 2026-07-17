/**
 * POST /api/v1/ai/knowledge/sources/:id/reindex
 *
 * Emite `knowledge_source.updated` para o worker re-processar a fonte.
 * Não persiste estado transitório — o schema só aceita
 * `last_index_status IN (NULL, 'failed', 'partial')`. O "queued" é puramente
 * client-side via mutation.isPending; o worker eventualmente atualiza
 * `last_indexed_at` / `chunks_count` / `last_index_status`.
 *
 * Auth: cookie session, role >= manager.
 * organization_id é resolvido do JWT — nunca do body/path.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const reindexBodySchema = z
  .object({
    force: z.boolean().optional(),
  })
  .partial()
  .optional();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  // Body é opcional; se vier, valida.
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      raw = undefined;
    }
    if (raw !== undefined && raw !== null) {
      const parsed = reindexBodySchema.safeParse(raw);
      if (!parsed.success) {
        return fail("validation_failed", "Campos inválidos.", 422, {
          requestId,
          details: parsed.error.flatten(),
        });
      }
    }
  }

  // Valida ownership via cliente user-scoped (RLS).
  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("ai_knowledge_sources")
    .select("id, agent_id, source_type")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (fetchErr) {
    console.error("[ai-knowledge-reindex] fetch failed:", fetchErr.message);
    return fail("internal_error", "Erro ao verificar fonte.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Fonte de conhecimento não encontrada.", 404, { requestId });
  }

  const ksRow = existing as { id: string; agent_id: string; source_type: string };

  const admin = createAdminClient();

  // Limpa apenas o erro anterior — `last_index_status` não tem estado
  // legítimo para "pending", então NÃO escrevemos nele.
  const { error: clearErr } = await admin
    .from("ai_knowledge_sources")
    .update({ last_index_error: null })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);

  if (clearErr) {
    console.warn("[ai-knowledge-reindex] clear last_index_error failed (non-blocking):", clearErr.message);
  }

  // Emit knowledge_source.updated (fire-and-forget).
  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: id,
    p_payload: {
      knowledge_source_id: id,
      agent_id: ksRow.agent_id,
      source_type: ksRow.source_type,
      triggered_by: "manual_reindex",
    },
    p_organization_id: activeOrg.orgId,
  } as never);

  if (emitErr) {
    console.warn("[ai-knowledge-reindex] emit_event failed (non-blocking):", emitErr.message);
  }

  return ok({ id, queued: true as const, agent_id: ksRow.agent_id }, { requestId });
}
