import type { SupabaseClient } from "@supabase/supabase-js";
import { parseSocialMessage } from "./parser";
import { ingestZernioInbound } from "../zernio/ingest";
/** Verify the account from the tenant-owned session before any message effects. */
export async function ingestSocialInbound(
  db: SupabaseClient,
  org: string,
  sessionId: string,
  payload: unknown,
) {
  const { data: session, error } = await db
    .from("channel_sessions")
    .select("zernio_account_id, metadata")
    .eq("organization_id", org)
    .eq("id", sessionId)
    .eq("provider", "zernio_social")
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error("social_session_lookup_failed");
  if (!session) return { status: "ignored", reason: "canal_desconhecido" };
  const platform = (session.metadata as Record<string, unknown>)?.social_platform;
  if (typeof platform !== "string") throw new Error("social_platform_missing");
  const message = parseSocialMessage(payload, session.zernio_account_id as string, platform);
  if (!message) return { status: "ignored", reason: "evento_de_outra_conta_ou_sem_interesse" };
  return ingestZernioInbound(db, {
    organizationId: org,
    channelSessionId: sessionId,
    payload,
    socialMessage: message,
  });
}

/** Subscription delivery is account-wide at the provider. Do not archive other profiles' payloads. */
export async function socialPayloadBelongsToSession(
  db: SupabaseClient,
  org: string,
  sessionId: string,
  raw: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("channel_sessions")
    .select("zernio_account_id, metadata")
    .eq("organization_id", org)
    .eq("id", sessionId)
    .eq("provider", "zernio_social")
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error("social_session_lookup_failed");
  if (!data) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object") return false;
  const account = (payload as Record<string, unknown>).account;
  if (!account || typeof account !== "object") return false;
  const observed = account as Record<string, unknown>;
  return (
    observed.id === data.zernio_account_id &&
    observed.platform === (data.metadata as Record<string, unknown>)?.social_platform
  );
}
