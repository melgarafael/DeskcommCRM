import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { FollowupFlowDetailRow } from "@/hooks/followup/useFollowupFlow";
import { FlowBuilder } from "./_components/FlowBuilder";

export const dynamic = "force-dynamic";

const DETAIL_COLUMNS =
  "id, name, status, active_version_id, draft_graph, handoff_policy, trigger_config, created_at, updated_at";

export default async function FollowupFlowBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const [{ data: pointer }, { data: versionRows }] = await Promise.all([
    supabase
      .from("followup_flow_pointers")
      .select(DETAIL_COLUMNS)
      .eq("id", id)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle(),
    supabase
      .from("followup_flow_versions")
      .select("id, created_at")
      .eq("organization_id", activeOrg.orgId)
      .eq("pointer_id", id)
      .order("created_at", { ascending: false }),
  ]);

  if (!pointer) notFound();

  const flow: FollowupFlowDetailRow = {
    ...(pointer as unknown as Omit<FollowupFlowDetailRow, "versions_count" | "previous_version_id">),
    versions_count: versionRows?.length ?? 0,
    previous_version_id: versionRows?.[1]?.id ?? null,
  };

  return (
    <div className="flex h-full flex-col">
      <FlowBuilder flowId={id} initialData={flow} />
    </div>
  );
}
