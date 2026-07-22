/**
 * Publish wrapper around the SQL function fn_publish_followup_flow_version
 * (migration 0056). Mirrors lib/ai/agents/publish.ts — insert version +
 * activate pointer happen atomically inside the SECURITY DEFINER function,
 * called via the admin client since EXECUTE is revoked from authenticated.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowGraph } from "./graph-schema";

export interface PublishFlowOk {
  ok: true;
  version_id: string;
}

export interface PublishFlowFail {
  ok: false;
  code: "pointer_not_found" | "internal_error";
  message: string;
}

export type PublishFlowResult = PublishFlowOk | PublishFlowFail;

export async function publishFollowupFlowVersion(
  admin: SupabaseClient,
  params: { orgId: string; pointerId: string; graph: FlowGraph; createdBy: string },
): Promise<PublishFlowResult> {
  const { data, error } = await admin.rpc("fn_publish_followup_flow_version", {
    p_org: params.orgId,
    p_pointer: params.pointerId,
    p_graph: params.graph,
    p_created_by: params.createdBy,
  });

  if (error) {
    const raw = (error.message ?? "").trim();
    if (raw === "pointer_not_found") {
      return { ok: false, code: "pointer_not_found", message: raw };
    }
    return { ok: false, code: "internal_error", message: raw || "publish_failed" };
  }

  if (typeof data !== "string") {
    return { ok: false, code: "internal_error", message: "no_version_id_returned" };
  }
  return { ok: true, version_id: data };
}
