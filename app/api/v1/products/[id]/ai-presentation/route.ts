import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  audioPertenceAoProduto,
  BUCKET_DA_APRESENTACAO,
  catalogProductPresentationPatchSchema,
  type CatalogProductPresentationRow,
  publicCatalogProductPresentation,
} from "@/lib/catalogo/apresentacao";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() }).strict();
const PRESENTATION_COLUMNS =
  "id, organization_id, catalog_product_id, enabled, kind, title, text_content, " +
  "use_catalog_photos, show_price, audio_storage_path, audio_mime, audio_size_bytes, " +
  "created_at, updated_at";

async function readProduct(
  organizationId: string,
  productId: string,
): Promise<{ id: string; fotos: string[] } | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("catalog_products")
    .select("id, fotos")
    .eq("organization_id", organizationId)
    .eq("id", productId)
    .maybeSingle();
  return data ? { id: data.id, fotos: data.fotos ?? [] } : null;
}

async function readPresentation(
  organizationId: string,
  productId: string,
): Promise<CatalogProductPresentationRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("catalog_product_presentations")
    .select(PRESENTATION_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("catalog_product_id", productId)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as CatalogProductPresentationRow | null;
}

async function sanitizedPresentation(
  row: CatalogProductPresentationRow | null,
  organizationId: string,
  productId: string,
) {
  if (!row?.audio_storage_path) return publicCatalogProductPresentation(row);
  if (!audioPertenceAoProduto(row.audio_storage_path, organizationId, productId)) {
    return publicCatalogProductPresentation({
      ...row,
      audio_storage_path: null,
      audio_mime: null,
      audio_size_bytes: null,
    });
  }
  const { data } = await createAdminClient()
    .storage.from(BUCKET_DA_APRESENTACAO)
    .createSignedUrl(row.audio_storage_path, 3600);
  return publicCatalogProductPresentation(row, data?.signedUrl ?? null);
}

async function parseProductId(params: Promise<{ id: string }>) {
  return paramsSchema.safeParse(await params);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", {
    requestId,
    resource: "catalog_product_presentations",
  });
  if (!authz.ok) return authz.response;
  const t = (text: string) => traduzir(text, authz.user.idioma);
  const parsedParams = await parseProductId(params);
  if (!parsedParams.success) {
    return fail("validation_failed", t("Produto inválido."), 422, { requestId });
  }
  const productId = parsedParams.data.id;
  const organizationId = authz.org.orgId;
  if (!(await readProduct(organizationId, productId))) {
    return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  }

  try {
    const row = await readPresentation(organizationId, productId);
    return ok(await sanitizedPresentation(row, organizationId, productId), { requestId });
  } catch {
    return fail("internal_error", t("Erro ao carregar a apresentação."), 500, { requestId });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "catalog_product_presentations",
  });
  if (!authz.ok) return authz.response;
  const t = (text: string) => traduzir(text, authz.user.idioma);
  const parsedParams = await parseProductId(params);
  if (!parsedParams.success) {
    return fail("validation_failed", t("Produto inválido."), 422, { requestId });
  }
  const productId = parsedParams.data.id;
  const organizationId = authz.org.orgId;
  const parsed = catalogProductPresentationPatchSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const product = await readProduct(organizationId, productId);
  if (!product) {
    return fail("not_found", t("Produto não encontrado."), 404, { requestId });
  }

  let current: CatalogProductPresentationRow | null;
  try {
    current = await readPresentation(organizationId, productId);
  } catch {
    return fail("internal_error", t("Erro ao salvar a apresentação."), 500, { requestId });
  }
  if (current?.updated_at !== parsed.data.expected_updated_at) {
    return fail("conflict", t("A apresentação mudou. Recarregue e tente novamente."), 409, {
      requestId,
    });
  }
  if (parsed.data.enabled && parsed.data.kind === "audio" && !current?.audio_storage_path) {
    return fail("validation_failed", t("Envie o áudio antes de ativar a apresentação."), 422, {
      requestId,
      details: { kind: ["missing_audio"] },
    });
  }
  if (parsed.data.enabled && parsed.data.use_catalog_photos && product.fotos.length === 0) {
    return fail(
      "validation_failed",
      t("Cadastre fotos ou desative o uso das fotos antes de ativar a apresentação."),
      422,
      { requestId, details: { use_catalog_photos: ["missing_photos"] } },
    );
  }

  const values = {
    enabled: parsed.data.enabled,
    kind: parsed.data.kind,
    title: parsed.data.title?.trim() || null,
    text_content: parsed.data.text_content?.trim() || null,
    use_catalog_photos: parsed.data.use_catalog_photos,
    show_price: parsed.data.show_price,
  };
  const supabase = await createClient();
  const result = current
    ? await supabase
        .from("catalog_product_presentations")
        .update(values)
        .eq("organization_id", organizationId)
        .eq("catalog_product_id", productId)
        .eq("updated_at", current.updated_at)
        .select(PRESENTATION_COLUMNS)
        .maybeSingle()
    : await supabase
        .from("catalog_product_presentations")
        .insert({ organization_id: organizationId, catalog_product_id: productId, ...values })
        .select(PRESENTATION_COLUMNS)
        .maybeSingle();

  if (result.error?.code === "23505" || (!result.error && !result.data)) {
    return fail("conflict", t("A apresentação mudou. Recarregue e tente novamente."), 409, {
      requestId,
    });
  }
  if (result.error) {
    return fail("internal_error", t("Erro ao salvar a apresentação."), 500, { requestId });
  }
  const saved = result.data as unknown as CatalogProductPresentationRow;
  await audit({
    organizationId,
    actorUserId: authz.user.id,
    action: "catalog_product.ai_presentation_updated",
    resourceType: "catalog_products",
    resourceId: productId,
    requestId,
    metadata: { enabled: saved.enabled, kind: saved.kind },
  });
  return ok(await sanitizedPresentation(saved, organizationId, productId), { requestId });
}
