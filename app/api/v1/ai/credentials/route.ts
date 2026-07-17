/**
 * GET  /api/v1/ai/credentials — lista credentials da org ativa (manager+).
 *                                Lê da view `ai_provider_credentials_safe`,
 *                                que NUNCA expõe campos cifrados.
 * POST /api/v1/ai/credentials — cria credential (admin). Plaintext da api_key
 *                                entra apenas neste endpoint, é cifrado AES-GCM
 *                                e descartado da memória. Validação async não
 *                                bloqueia a resposta.
 *
 * Spec 10 §4.2 / §7.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { bufToBytea, encryptKey } from "@/lib/crypto/aes_gcm";
import { validateProviderKey, type Provider } from "@/lib/ai/provider-validators";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

const createSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google"]),
  label: z.string().trim().min(1).max(80),
  api_key: z.string().trim().min(8).max(2048),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_provider_credentials_safe")
    .select(SAFE_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (error) {
    return fail("internal_error", "Erro ao listar credentials.", 500, { requestId });
  }
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = createSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;
  const provider = input.provider as Provider;

  let encrypted;
  try {
    encrypted = encryptKey(input.api_key);
  } catch (err) {
    console.error("[ai.credentials] encrypt failed", err);
    return fail("internal_error", "Erro ao cifrar credential.", 500, { requestId });
  }

  const admin = createAdminClient();
  const { data: created, error: insErr } = await admin
    .from("ai_provider_credentials")
    .insert({
      organization_id: activeOrg.orgId,
      provider,
      label: input.label,
      api_key_encrypted: bufToBytea(encrypted.ciphertext),
      api_key_iv: bufToBytea(encrypted.iv),
      api_key_tag: bufToBytea(encrypted.tag),
      api_key_last4: encrypted.last4,
      is_active: true,
      created_by: authUser.id,
    })
    .select(SAFE_COLUMNS)
    .single();

  if (insErr || !created) {
    if (insErr?.code === "23505") {
      return fail(
        "label_already_used",
        "Já existe uma credential com este label e provider.",
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao criar credential.", 500, { requestId });
  }

  await audit({
    action: "ai.credential_created",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_provider_credential",
    resourceId: created.id,
    requestId,
    metadata: {
      provider,
      label: input.label,
      last4: encrypted.last4,
    },
  });

  // Validação async fire-and-forget. Plaintext só vive até o callback resolver
  // — nunca persistido nem logado.
  void runAsyncValidation(created.id, activeOrg.orgId, provider, input.api_key);

  return ok(created, { status: 201, requestId });
}

async function runAsyncValidation(
  credentialId: string,
  organizationId: string,
  provider: Provider,
  apiKey: string,
): Promise<void> {
  try {
    const result = await validateProviderKey(provider, apiKey);
    const admin = createAdminClient();
    const patch = result.ok
      ? {
          validated_at: new Date().toISOString(),
          validation_error: null,
          models_available: result.models,
        }
      : {
          validated_at: null,
          validation_error: result.error,
        };
    const { error } = await admin
      .from("ai_provider_credentials")
      .update(patch)
      .eq("id", credentialId)
      .eq("organization_id", organizationId);
    if (error) {
      console.error("[ai.credentials] async validation persist failed", error.message);
    }
  } catch (err) {
    console.error("[ai.credentials] async validation crashed", err);
  }
}
