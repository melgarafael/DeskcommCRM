import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

const patchMetaCatalogSchema = z.object({
  catalog_id: z.string().trim().nullable().optional(),
  access_token: z.string().trim().nullable().optional(),
  feed_url: z
    .string()
    .trim()
    .url()
    .nullable()
    .optional()
    .or(z.literal("").transform(() => null)),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();

  const { data: orgData, error: orgError } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();

  if (orgError) {
    return fail("database_error", orgError.message, 500, { requestId });
  }

  const settings = (orgData?.settings as Record<string, unknown> | null) ?? {};
  const metaCatalog = (settings.meta_catalog as Record<string, unknown> | null) ?? {};

  // Se não tem catalog_id em settings, verificar se existe na channel_sessions como legado
  let catalogId = (metaCatalog.catalog_id as string | undefined) ?? null;
  if (!catalogId) {
    const { data: sessionData } = await admin
      .from("channel_sessions")
      .select("meta_catalog_id")
      .eq("organization_id", orgId)
      .is("archived_at", null)
      .not("meta_catalog_id", "is", null)
      .limit(1)
      .maybeSingle();

    if (sessionData?.meta_catalog_id) {
      catalogId = sessionData.meta_catalog_id;
    }
  }

  const hasCustomToken = Boolean(metaCatalog.access_token || metaCatalog.access_token_encrypted);
  // Verificar se há token oficial da Meta disponível na organização
  const { data: officialSession } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("provider", "meta")
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();

  const hasToken = hasCustomToken || Boolean(officialSession);

  return ok({
    config: {
      catalog_id: catalogId,
      has_token: hasToken,
      has_custom_token: hasCustomToken,
      feed_url: (metaCatalog.feed_url as string | undefined) ?? null,
      last_sync_at: (metaCatalog.last_sync_at as string | undefined) ?? null,
      products_count: (metaCatalog.products_count as number | undefined) ?? 0,
    },
  });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "catalog_products" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const body = await req.json().catch(() => null);
  const parsed = patchMetaCatalogSchema.safeParse(body);
  if (!parsed.success) {
    return fail("invalid_input", "Dados inválidos", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  const { data: orgData, error: orgError } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();

  if (orgError) {
    return fail("database_error", orgError.message, 500, { requestId });
  }

  const currentSettings = (orgData?.settings as Record<string, unknown> | null) ?? {};
  const currentMeta = (currentSettings.meta_catalog as Record<string, unknown> | null) ?? {};

  const novoCatalogId =
    parsed.data.catalog_id !== undefined ? parsed.data.catalog_id : (currentMeta.catalog_id as string | null);

  const novoFeedUrl =
    parsed.data.feed_url !== undefined ? parsed.data.feed_url : (currentMeta.feed_url as string | null);

  let novoToken = currentMeta.access_token as string | null;
  let novoTokenEnc = (currentMeta.access_token_encrypted as string | null) ?? null;
  if (parsed.data.access_token !== undefined) {
    if (parsed.data.access_token && parsed.data.access_token.trim().length > 0) {
      const cifrado = await encryptWebhookSecret(admin, parsed.data.access_token.trim());
      if (cifrado) {
        novoTokenEnc = cifrado;
        novoToken = null;
      } else {
        novoToken = parsed.data.access_token.trim();
        novoTokenEnc = null;
      }
    } else {
      novoToken = null;
      novoTokenEnc = null;
    }
  }

  const updatedMetaCatalog = {
    ...currentMeta,
    catalog_id: novoCatalogId,
    access_token: novoToken,
    access_token_encrypted: novoTokenEnc,
    feed_url: novoFeedUrl,
  };

  const updatedSettings = {
    ...currentSettings,
    meta_catalog: updatedMetaCatalog,
  };

  const { error: updateError } = await admin
    .from("organizations")
    .update({ settings: updatedSettings })
    .eq("id", orgId);

  if (updateError) {
    return fail("database_error", updateError.message, 500, { requestId });
  }

  // Sincroniza em channel_sessions para mensagens interativas de produto
  await admin
    .from("channel_sessions")
    .update({ meta_catalog_id: novoCatalogId })
    .eq("organization_id", orgId)
    .is("archived_at", null);

  await audit({
    organizationId: orgId,
    actorUserId: authz.user.id,
    action: "catalog_product.meta_config_updated",
    requestId,
    resourceType: "organization_settings",
    resourceId: orgId,
    metadata: {
      catalog_id: novoCatalogId,
      feed_url: novoFeedUrl,
      has_token: Boolean(novoToken || novoTokenEnc),
    },
  });

  return ok({
    config: {
      catalog_id: novoCatalogId,
      feed_url: novoFeedUrl,
      has_token: Boolean(novoToken || novoTokenEnc),
      last_sync_at: (currentMeta.last_sync_at as string | undefined) ?? null,
      products_count: (currentMeta.products_count as number | undefined) ?? 0,
    },
  });
}
