/**
 * Publish wrapper around the SQL function fn_publish_ai_agent_version.
 * Spec 10 §4.5.
 *
 * Returns a discriminated result so the caller maps validation errors to 422
 * with a stable error code, and unknown errors to 500.
 */
import { chaveDePlataforma } from "@/lib/ai/runtime/agent";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PUBLISH_ERROR_CODES, type PublishErrorCode } from "./validation";

export interface PublishOk {
  ok: true;
  agent_id: string;
  version_id: string;
  previous_version_id: string | null;
  published_at: string;
}

export interface PublishFail {
  ok: false;
  code: PublishErrorCode | "internal_error";
  message: string;
}

export type PublishResult = PublishOk | PublishFail;

interface PublishRow {
  agent_id: string;
  version_id: string;
  previous_version_id: string | null;
  published_at: string;
}

export async function publishAgentVersion(
  admin: SupabaseClient,
  params: { orgId: string; agentId: string; versionId: string; expectedProvenance?: "onboarding" | "legacy_reconciliation" },
): Promise<PublishResult> {
  const { data: version, error: readError } = await admin
    .from("ai_agent_versions")
    .select("provider,credential_id")
    .eq("organization_id", params.orgId)
    .eq("agent_id", params.agentId)
    .eq("id", params.versionId)
    .maybeSingle();
  if (readError || !version)
    return { ok: false, code: "version_not_found", message: "version_not_found" };
  const platform = version.credential_id === null;
  if (platform && !chaveDePlataforma(version.provider))
    return { ok: false, code: "credential_missing", message: "credential_missing" };
  const { data, error } = await admin.rpc("fn_publish_ai_agent_version", {
    p_org_id: params.orgId,
    p_agent_id: params.agentId,
    p_version_id: params.versionId,
    ...(params.expectedProvenance ? { p_platform_credential_verified: platform, p_expected_provenance: params.expectedProvenance } : platform ? { p_platform_credential_verified: true } : {}),
  });

  if (error) {
    // Postgres P0001 with the reason as message.
    const raw = (error.message ?? "").trim();
    if (PUBLISH_ERROR_CODES.has(raw)) {
      return { ok: false, code: raw as PublishErrorCode, message: raw };
    }
    return { ok: false, code: "internal_error", message: raw || "publish_failed" };
  }

  const row = Array.isArray(data)
    ? (data[0] as PublishRow | undefined)
    : (data as PublishRow | null);
  if (!row) {
    return { ok: false, code: "internal_error", message: "no_row_returned" };
  }
  return {
    ok: true,
    agent_id: row.agent_id,
    version_id: row.version_id,
    previous_version_id: row.previous_version_id,
    published_at: row.published_at,
  };
}
