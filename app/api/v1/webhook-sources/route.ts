/**
 * GET  /api/v1/webhook-sources — lista as fontes de webhook da org ativa.
 * POST /api/v1/webhook-sources — cria uma fonte (gera path_token no server).
 *
 * path_token NÃO é segredo forte (é a identidade pública da URL, como o
 * webhook_path_token do WAHA) — diferente de api_tokens, ele volta no corpo
 * de GET/POST pra UI montar a URL de captação.
 *
 * `secret` é write-only na leitura: GET devolve só `has_secret` (padrão
 * api-tokens — o plaintext aparece apenas na resposta do POST/PATCH que o
 * definiu). Cifragem at-rest (spec §10) é follow-up junto com os secrets de
 * config de regra.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createWebhookSourceSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("webhook_sources")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  const masked = (data ?? []).map(({ secret, ...rest }) => ({
    ...rest,
    has_secret: secret !== null,
  }));
  return ok(masked, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "webhook_sources" });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createWebhookSourceSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", "Dados inválidos.", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const pathToken = randomBytes(24).toString("base64url");

  const supabase = await createClient();
  const { data: created, error: insErr } = await supabase
    .from("webhook_sources")
    .insert({
      organization_id: activeOrg.orgId,
      created_by_user_id: user.id,
      name: parsed.data.name,
      path_token: pathToken,
      secret: parsed.data.secret ?? null,
      default_pipeline_id: parsed.data.default_pipeline_id,
      default_stage_id: parsed.data.default_stage_id,
      field_map: parsed.data.field_map ?? {},
      redirect_to: parsed.data.redirect_to ?? null,
    })
    .select("*")
    .single();
  if (insErr || !created) {
    return fail("internal_error", insErr?.message ?? "webhook_source_insert_failed", 500, { requestId });
  }

  void audit({
    action: "webhook.source_created",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "webhook_source",
    resourceId: created.id,
    requestId,
    metadata: { name: parsed.data.name },
  });

  return ok(created, { requestId, status: 201 });
}
