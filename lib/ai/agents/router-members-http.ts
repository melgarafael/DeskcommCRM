import type { SupabaseClient } from "@supabase/supabase-js";
import type { RouterMemberInput } from "./router-members";

/** Compatibility for HTTP-only installations, where native prospecting cannot run. */
export async function replaceRouterMembersHttp(
  admin: SupabaseClient,
  orgId: string,
  routerId: string,
  members: RouterMemberInput[],
) {
  const router = await admin
    .from("ai_routers")
    .select("id")
    .eq("organization_id", orgId)
    .eq("id", routerId)
    .maybeSingle();
  if (router.error) throw router.error;
  if (!router.data) throw new Error("router_not_found");
  if (new Set(members.map((m) => m.intent_name)).size !== members.length)
    throw new Error("duplicate_intent_name");
  const ids = [...new Set(members.map((m) => m.agent_id))];
  if (ids.length) {
    const agents = await admin
      .from("ai_agents")
      .select("id")
      .eq("organization_id", orgId)
      .is("archived_at", null)
      .in("id", ids);
    if (agents.error) throw agents.error;
    if (agents.data?.length !== ids.length) throw new Error("member_agent_not_found");
  }
  const existing = await admin
    .from("ai_router_members")
    .select("id,agent_id,intent_name,intent_description,examples,position")
    .eq("organization_id", orgId)
    .eq("router_id", routerId);
  if (existing.error) throw existing.error;
  // Preserve the established HTTP-only replacement order. Upsert-then-prune
  // would let two successful callers delete one another's desired members.
  const removed = await admin
    .from("ai_router_members")
    .delete()
    .eq("organization_id", orgId)
    .eq("router_id", routerId);
  if (removed.error) throw removed.error;
  if (!members.length) return;
  const inserted = await admin
    .from("ai_router_members")
    .insert(
      members.map((member, position) => ({
        ...member,
        position,
        organization_id: orgId,
        router_id: routerId,
      })),
    );
  if (!inserted.error) return;
  // No transaction exists over HTTP in this schema. Restore the previous set
  // on a failed insert, without overwriting a concurrent successful writer.
  if (existing.data?.length) {
    const restored = await admin.from("ai_router_members").upsert(
      existing.data.map((row) => ({ ...row, organization_id: orgId, router_id: routerId })),
      { onConflict: "router_id,intent_name", ignoreDuplicates: true },
    );
    if (restored.error) throw new Error("router_members_restore_failed", { cause: restored.error });
  }
  throw inserted.error;
}
