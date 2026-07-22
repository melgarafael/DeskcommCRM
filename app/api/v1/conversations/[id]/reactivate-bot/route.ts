/**
 * POST /api/v1/conversations/[id]/reactivate-bot
 *
 * Devolve o controle da conversa ao bot — clears `bot_silenced_until` que foi
 * setado pelo handoff orchestrator (`'infinity'` por design IA-06).
 *
 * Auth: cookie session, role >= agent.
 * Audit: action `ai.reactivated_by_agent`.
 * Event: emite `ai.handoff_resolved` no event_log (Task 5.2, followup) — o
 * fechamento do handoff que `lib/ai/handoff/orchestrator.ts` (ai.handoff_triggered)
 * não tinha contraparte nenhuma pra sinalizar; sem isso, um enrollment de
 * follow-up pausado por handoff (`lib/followup/reactivity.ts`) nunca teria
 * como retomar (violaria a garantia anti-Tomik — pausa sem consumidor de
 * retomada). AWAITED (não fire-and-forget, diferente das ~30 outras rotas que
 * usam esse padrão): este evento é o ÚNICO produtor do sinal de fechamento —
 * sem retry, sem cron que reemite. Um drop aqui não perde só um audit trail
 * (caso comum), órfã um `paused_handoff` pra sempre. Se o emit falhar, a rota
 * devolve 500 (a query de update já é idempotente — reclicar reactivate-bot
 * de novo é seguro: `bot_silenced_until` já null não muda, e o emit é
 * retentado).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  const supabase = await createClient();

  // RLS will already restrict to the active org, but we filter explicitly
  // because clarity > implicit.
  const { data, error } = await supabase
    .from("conversations")
    .update({ bot_silenced_until: null })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select("id, organization_id, contact_id, bot_silenced_until")
    .maybeSingle();

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  await audit({
    action: "ai.reactivated_by_agent",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
  });

  const { error: emitErr } = await supabase.rpc("emit_event", {
    p_event_type: "ai.handoff_resolved",
    p_entity_kind: "conversation",
    p_entity_id: id,
    p_payload: { conversation_id: id, contact_id: data.contact_id, organization_id: activeOrg.orgId },
    p_metadata: { source: "reactivate-bot", request_id: requestId },
    p_organization_id: activeOrg.orgId,
  });
  if (emitErr) {
    console.error("[reactivate-bot] emit ai.handoff_resolved failed", emitErr.message);
    return fail("internal_error", "Bot reativado, mas o sinal de retomada do follow-up falhou — tente de novo.", 500, {
      requestId,
    });
  }

  return ok({ reactivated: true }, { requestId });
}
