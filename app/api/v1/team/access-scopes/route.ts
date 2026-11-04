import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { ok, fail } from "@/lib/api/wrappers";
import { memberAccessPatchSchema } from "@/lib/access/schema";
export const dynamic = "force-dynamic";
export async function GET(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "team_access" });
  if (!auth.ok) return auth.response;
  const id = z.string().uuid().safeParse(new URL(req.url).searchParams.get("user_id"));
  if (!id.success) return fail("validation_failed", "Selecione um atendente.", 422, { requestId });
  const db: SupabaseClient = await createClient();
  const org = auth.org.orgId;
  const [member, scope, pipelines, privacy, channels] = await Promise.all([
    db
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", org)
      .eq("user_id", id.data)
      .eq("role", "agent")
      .is("revoked_at", null)
      .maybeSingle(),
    db
      .from("member_access_scopes")
      .select("pipeline_ids,channel_ids,restrict_contacts")
      .eq("organization_id", org)
      .eq("user_id", id.data)
      .maybeSingle(),
    db.from("crm_pipelines").select("id,name").eq("organization_id", org).eq("is_archived", false),
    db
      .rpc("fn_contact_context_private", { p_org: org }),
    db
      .from("channel_sessions")
      .select("id,display_name,phone_number")
      .eq("organization_id", org)
      .is("archived_at", null),
  ]);
  if (member.error || scope.error || pipelines.error || channels.error || privacy.error)
    return fail("internal_error", "Não foi possível carregar os acessos.", 500, { requestId });
  if (!member.data) return fail("not_found", "Atendente não encontrado.", 404, { requestId });
  return ok(
    { scope: scope.data, pipelines: pipelines.data, channels: channels.data ,
      privacy_enabled: privacy.data === true,
    },
    { requestId },
  );
}
export async function PATCH(req: Request): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "team_access" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const parsed = memberAccessPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Confira o atendente, os funis e os números.", 422, {
      requestId,
    });
  const db: SupabaseClient = await createClient();
  const { data, error } = await db.rpc("fn_set_member_access_scopes", {
    p_org: auth.org.orgId,
    p_user: parsed.data.user_id,
    p_pipelines: parsed.data.pipeline_ids,
    p_channels: parsed.data.channel_ids,
    p_restrict_contacts: parsed.data.restrict_contacts,
    p_reset: parsed.data.reset,
  });
  if (error)
    return fail(
      error.code === "42501" ? "forbidden" : "validation_failed",
      "Não foi possível salvar. Confira a equipe e os acessos.",
      error.code === "42501" ? 403 : 422,
      { requestId },
    );
  return ok(data, { requestId });
}
