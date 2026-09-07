import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { listClassifierModels } from "@/lib/ai/classifier-models";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { createClient } from "@/lib/supabase/server";
import type { RouterDetailState } from "@/hooks/ai/useRouters";
import { RouterEditorClient } from "./_client";

export const dynamic = "force-dynamic";

const ROUTER_DETAIL_COLUMNS = "id, name, channel_session_id, is_active, config, fallback_agent_id";
const MEMBER_COLUMNS = "id, agent_id, intent_name, intent_description, examples, position";

export default async function RouterEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();

  const [{ data: routerRow }, { data: memberRows }, { data: agentRows }, channelSessions] =
    await Promise.all([
      supabase
        .from("ai_routers")
        .select(ROUTER_DETAIL_COLUMNS)
        .eq("id", id)
        .eq("organization_id", activeOrg.orgId)
        .maybeSingle(),
      supabase
        .from("ai_router_members")
        .select(MEMBER_COLUMNS)
        .eq("router_id", id)
        .eq("organization_id", activeOrg.orgId)
        .order("position", { ascending: true }),
      supabase
        .from("ai_agents")
        .select("id, name")
        .eq("organization_id", activeOrg.orgId)
        .is("archived_at", null)
        .order("name", { ascending: true }),
      listSelectableChannels(supabase, activeOrg.orgId),
    ]);

  if (!routerRow) notFound();

  // Só os modelos que esta organização consegue usar de fato — ver a razão em
  // lib/ai/classifier-models.
  const classifierModels = await listClassifierModels(supabase, activeOrg.orgId, {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
  });

  const initialState: RouterDetailState = {
    router: routerRow as RouterDetailState["router"],
    members: (memberRows ?? []) as RouterDetailState["members"],
  };

  const agents = agentRows ?? [];

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <RouterEditorClient
        routerId={id}
        initialState={initialState}
        agents={agents}
        channelSessions={channelSessions}
        classifierModels={classifierModels}
      />
    </div>
  );
}
