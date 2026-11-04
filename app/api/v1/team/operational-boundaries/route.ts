import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { mfaEmDivida } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
export const dynamic = "force-dynamic";
const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("commercial_source"),
      source_id: z.string().uuid(),
      channel_id: z.string().uuid(),
      disabled: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal("commercial_source_retry"), lead_id: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("privacy"),
      basic_field_keys: z.array(z.string().min(1).max(100)).max(200),
      basic_tags: z.array(z.string().min(1).max(100)).max(200),
      ack_archive: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("commercial"),
      channel_id: z.string().uuid(),
      pipeline_id: z.string().uuid(),
      member_ids: z.array(z.string().uuid()).max(200),
      disabled: z.boolean(),
    })
    .strict(),
]);
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "operational_boundaries" });
  if (!auth.ok) return auth.response;
  const db = await createClient(),
    org = auth.org.orgId;
  const [privacy, rules, pipelines, channels, pending, sources, sourceBindings, sourcePending] =
    await Promise.all([
      db
        .from("organization_data_boundaries")
        .select("basic_field_keys,basic_tags,enabled_at")
        .eq("organization_id", org)
        .maybeSingle(),
      db
        .from("commercial_routing_rules")
        .select("channel_id,pipeline_id,member_ids")
        .eq("organization_id", org),
      db
        .from("crm_pipelines")
        .select("id,name")
        .eq("organization_id", org)
        .eq("is_archived", false),
      db
        .from("channel_sessions")
        .select("id,display_name,phone_number")
        .eq("organization_id", org)
        .is("archived_at", null),
      db
        .from("conversation_business_contexts")
        .select("conversation_id,status")
        .eq("organization_id", org)
        .neq("status", "assigned"),
      db
        .from("webhook_sources")
        .select("id,name,default_pipeline_id")
        .eq("organization_id", org)
        .eq("is_active", true),
      db
        .from("commercial_source_bindings")
        .select("source_id,rule_channel_id")
        .eq("organization_id", org),
      db
        .from("commercial_source_receipts")
        .select("lead_id,source_id,status")
        .eq("organization_id", org)
        .neq("status", "assigned"),
    ]);
  if (
    [privacy, rules, pipelines, channels, pending, sources, sourceBindings, sourcePending].some(
      (r) => r.error,
    )
  )
    return fail("internal_error", "Não foi possível carregar a configuração.", 500, { requestId });
  return ok(
    {
      privacy: privacy.data,
      rules: rules.data,
      pipelines: pipelines.data,
      channels: channels.data,
      pending: pending.data,
      sources: sources.data,
      source_bindings: sourceBindings.data,
      source_pending: sourcePending.data,
    },
    { requestId },
  );
}
export async function POST(req: Request): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "operational_boundaries" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const input = schema.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return fail("validation_failed", "Confira os campos e a confirmação.", 422, { requestId });
  const db = await createClient(),
    x = input.data;
  const result =
    x.action === "privacy"
      ? await db.rpc("fn_set_contact_data_boundary", {
          p_org: auth.org.orgId,
          p_basic_keys: x.basic_field_keys,
          p_basic_tags: x.basic_tags,
          p_ack_archive: x.ack_archive,
        })
      : x.action === "commercial_source"
        ? await db.rpc("fn_set_commercial_source", {
            p_org: auth.org.orgId,
            p_source: x.source_id,
            p_channel: x.channel_id,
            p_disabled: x.disabled,
          })
        : x.action === "commercial_source_retry"
          ? await db.rpc("fn_commercial_source_ingress", {
              p_org: auth.org.orgId,
              p_lead: x.lead_id,
            })
          : await db.rpc("fn_set_commercial_rule", {
              p_org: auth.org.orgId,
              p_channel: x.channel_id,
              p_pipeline: x.pipeline_id,
              p_members: x.member_ids,
              p_disabled: x.disabled,
            });
  if (result.error)
    return fail(
      result.error.code === "42501" ? "forbidden" : "validation_failed",
      "Não foi possível salvar. Confira os acessos, o número e o funil.",
      result.error.code === "42501" ? 403 : 422,
      { requestId },
    );
  return ok(result.data, { requestId });
}
