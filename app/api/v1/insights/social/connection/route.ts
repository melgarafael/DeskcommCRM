import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { lerConexaoSocial } from "@/lib/social-insights/meta-client";

export const dynamic = "force-dynamic";

const saveSchema = z.object({
  facebook_page_id: z.string().trim().nullable().optional(),
  facebook_page_name: z.string().trim().nullable().optional(),
  instagram_business_id: z.string().trim().nullable().optional(),
  instagram_username: z.string().trim().nullable().optional(),
  access_token: z.string().trim().nullable().optional(),
});

export async function GET(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "social_insights" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const { conexao } = await lerConexaoSocial(admin, orgId);
  return ok(conexao ?? null, { requestId });
}

export async function POST(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "social_insights" });
  if (!authz.ok) return authz.response;

  const body = await req.json().catch(() => null);
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_input", "Dados inválidos", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const dadosAtuais = await admin
    .from("social_insights_connections")
    .select("access_token_encrypted")
    .eq("organization_id", orgId)
    .maybeSingle();

  let tokenEncrypted: string | null = dadosAtuais.data?.access_token_encrypted ?? null;
  if (parsed.data.access_token) {
    tokenEncrypted = await encryptWebhookSecret(admin, parsed.data.access_token);
  }

  const { error } = await admin.from("social_insights_connections").upsert(
    {
      organization_id: orgId,
      facebook_page_id: parsed.data.facebook_page_id || null,
      facebook_page_name: parsed.data.facebook_page_name || null,
      instagram_business_id: parsed.data.instagram_business_id || null,
      instagram_username: parsed.data.instagram_username || null,
      access_token_encrypted: tokenEncrypted,
      status: tokenEncrypted ? "connected" : "disconnected",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id" },
  );

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const { conexao } = await lerConexaoSocial(admin, orgId);
  return ok(conexao, { requestId });
}

export async function DELETE(req: NextRequest) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "social_insights" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  await admin.from("social_insights_connections").delete().eq("organization_id", orgId);

  return ok({ desconectado: true }, { requestId });
}
