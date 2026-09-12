import type { SupabaseClient } from "@supabase/supabase-js";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";
import { PROVIDERS_DE_MENSAGEM } from "@/lib/channels/capabilities";

export interface ChannelRoutingSettings {
  channels: Array<{ id: string; display_name: string | null; phone_number: string | null; user_ids: string[]; mode: "legacy_unconfigured" | "restricted" | "restricted_empty" }>;
  members: Array<{ id: string; name: string }>;
}
export async function loadChannelRoutingSettings(db: SupabaseClient, org: string): Promise<ChannelRoutingSettings> {
  const results = await Promise.all([
    db.from("channel_sessions").select("id, display_name, phone_number").eq("organization_id", org).is("archived_at", null).in("provider", [...PROVIDERS_DE_MENSAGEM]).order("created_at"),
    db.from("user_organizations").select("user_id").eq("organization_id", org).is("revoked_at", null).in("role", ["agent", "manager", "admin"]),
    db.from("channel_routing_policies").select("id, channel_session_id").eq("organization_id", org),
    db.from("channel_routing_responsibles").select("policy_id, user_id").eq("organization_id", org),
  ]);
  for (const result of results) if (result.error) throw new Error(result.error.message);
  const channels = results[0].data ?? [];
  const members = results[1].data ?? [];
  const policies = results[2].data ?? [];
  const responsibles = results[3].data ?? [];
  const ids = members.map((m) => String(m.user_id));
  const names = await nomesDosAtendentes(ids);
  return {
    channels: channels.map((c) => {
      const policy = policies.find((p) => p.channel_session_id === c.id);
      const user_ids = policy ? responsibles.filter((r) => r.policy_id === policy.id && ids.includes(r.user_id)).map((r) => String(r.user_id)) : [];
      return { id: c.id, display_name: c.display_name, phone_number: c.phone_number, user_ids,
        mode: !policy ? "legacy_unconfigured" : user_ids.length ? "restricted" : "restricted_empty" };
    }),
    members: ids.map((id) => ({ id, name: names.get(id) ?? "Atendente sem nome" })),
  };
}
