import type { SupabaseClient } from "@supabase/supabase-js";
/** Nome legado só localiza linha da própria org; nunca autoriza acesso remoto. */
export async function loadOnboardingChannel(db: SupabaseClient, organizationId: string) {
  const { data, error } = await db.from("channel_sessions")
    .select("id, organization_id, waha_session_name, status, archived_at")
    .eq("organization_id", organizationId).eq("provider", "waha")
    .or(`metadata->>onboarding.eq.true,waha_session_name.eq.org_${organizationId.slice(0, 8)}`)
    .order("created_at").limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data as { id: string; organization_id: string; waha_session_name: string; status: string; archived_at: string | null } | null;
}
