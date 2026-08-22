/**
 * GET/POST /api/v1/integrations/paysuite — credenciais PaySuite da organização.
 *
 * Sem fluxo OAuth (o PaySuite não tem): o admin cola o Bearer token e o
 * webhook secret que pegou no dashboard deles (Settings > API Access), esta
 * rota cifra os dois (`fn_encrypt_oauth`, mesma infra de `tenant_integrations`)
 * e devolve a URL de webhook para colar de volta no dashboard do PaySuite.
 *
 * Nunca devolve o token/segredo em texto — nem cifrado. `payment_credentials`
 * não tem NENHUMA policy de SELECT (ver migration 0162): só esta rota, com
 * service role, lê e decifra.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

const saveSchema = z.object({
  api_token: z.string().min(10),
  webhook_secret: z.string().min(10),
});

function resolveBaseUrl(req: NextRequest): string {
  const envBase = process.env.NEXT_PUBLIC_APP_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  return new URL(req.url).origin;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "payment_credentials" });
  if (!authz.ok) return authz.response;
  const activeOrg = authz.org;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("payment_credentials")
    .select("status, status_reason, webhook_path_token, updated_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "paysuite")
    .maybeSingle();

  if (error) {
    return fail("internal_error", "Erro ao consultar configuração.", 500, { requestId });
  }
  if (!data) {
    return ok({ configured: false }, { requestId });
  }

  const row = data as {
    status: string;
    status_reason: string | null;
    webhook_path_token: string;
    updated_at: string;
  };
  const base = resolveBaseUrl(req);
  return ok(
    {
      configured: true,
      status: row.status,
      status_reason: row.status_reason,
      webhook_url: `${base}/api/v1/webhooks/payments/paysuite/${row.webhook_path_token}`,
      updated_at: row.updated_at,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "payment_credentials" });
  if (!authz.ok) return authz.response;
  const activeOrg = authz.org;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }
  const parsed = saveSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const [tokenEnc, secretEnc] = await Promise.all([
    encryptWebhookSecret(admin, parsed.data.api_token),
    encryptWebhookSecret(admin, parsed.data.webhook_secret),
  ]);

  if (!tokenEnc || !secretEnc) {
    return fail(
      "internal_error",
      "Não consegui cifrar as credenciais — verifique a configuração de criptografia do servidor.",
      500,
      { requestId },
    );
  }

  const { data: existing } = await admin
    .from("payment_credentials")
    .select("id, webhook_path_token")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "paysuite")
    .maybeSingle();

  const { error: upsertErr } = existing
    ? await admin
        .from("payment_credentials")
        .update({
          api_token_encrypted: tokenEnc,
          webhook_secret_encrypted: secretEnc,
          status: "healthy",
          status_reason: null,
        })
        .eq("id", (existing as { id: string }).id)
    : await admin.from("payment_credentials").insert({
        organization_id: activeOrg.orgId,
        provider: "paysuite",
        api_token_encrypted: tokenEnc,
        webhook_secret_encrypted: secretEnc,
        status: "healthy",
      });

  if (upsertErr) {
    return fail("internal_error", "Erro ao salvar configuração.", 500, { requestId });
  }

  const { data: saved } = await admin
    .from("payment_credentials")
    .select("webhook_path_token")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "paysuite")
    .maybeSingle();

  const base = resolveBaseUrl(req);
  const webhookPathToken = (saved as { webhook_path_token: string } | null)?.webhook_path_token ?? "";

  return ok(
    {
      configured: true,
      status: "healthy",
      webhook_url: `${base}/api/v1/webhooks/payments/paysuite/${webhookPathToken}`,
    },
    { status: 201, requestId },
  );
}
