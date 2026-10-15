import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  BUCKET_DA_APRESENTACAO,
  catalogProductPresentationAudioMutationSchema,
  isOggOpus,
  MIME_DO_AUDIO_DA_APRESENTACAO,
  publicCatalogProductPresentation,
  TAMANHO_MAXIMO_DO_AUDIO,
  type CatalogProductPresentationRow,
} from "@/lib/catalogo/apresentacao";
import { removeCatalogPresentationAudio } from "@/lib/catalogo/apresentacao-no-bucket";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { transcodificarNotaDeVoz } from "@/lib/messaging/media/voice-transcode";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() }).strict();
const PRESENTATION_COLUMNS =
  "id, organization_id, catalog_product_id, enabled, kind, title, text_content, " +
  "use_catalog_photos, show_price, audio_storage_path, audio_mime, audio_size_bytes, " +
  "created_at, updated_at";

async function productExists(organizationId: string, productId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("catalog_products")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("id", productId)
    .maybeSingle();
  return data !== null;
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

function conflict(t: (text: string) => string, requestId: string) {
  return fail("conflict", t("A apresentaÃ§Ã£o mudou. Recarregue e tente novamente."), 409, {
    requestId,
  });
}

function expectedFromForm(value: FormDataEntryValue | null): unknown {
  if (value === "null") return null;
  return value;
}

export async function POST(
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
  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return fail("validation_failed", t("Produto invÃ¡lido."), 422, { requestId });
  }
  const productId = parsedParams.data.id;
  const organizationId = authz.org.orgId;
  if (!(await productExists(organizationId, productId))) {
    return fail("not_found", t("Produto nÃ£o encontrado."), 404, { requestId });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > TAMANHO_MAXIMO_DO_AUDIO + 1_048_576) {
    return fail("payload_too_large", t("O Ã¡udio precisa ter atÃ© 16 MB."), 413, { requestId });
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const mutation = catalogProductPresentationAudioMutationSchema.safeParse({
    expected_updated_at: expectedFromForm(form?.get("expected_updated_at") ?? null),
  });
  if (!(file instanceof File) || !mutation.success) {
    return fail("validation_failed", t("Arquivo e versÃ£o da apresentaÃ§Ã£o sÃ£o obrigatÃ³rios."), 422, {
      requestId,
    });
  }
  if (file.size <= 0 || file.size > TAMANHO_MAXIMO_DO_AUDIO) {
    return fail(
      file.size > TAMANHO_MAXIMO_DO_AUDIO ? "payload_too_large" : "validation_failed",
      t(file.size > TAMANHO_MAXIMO_DO_AUDIO ? "O Ã¡udio precisa ter atÃ© 16 MB." : "O arquivo estÃ¡ vazio."),
      file.size > TAMANHO_MAXIMO_DO_AUDIO ? 413 : 422,
      { requestId },
    );
  }

  let current: CatalogProductPresentationRow | null;
  try {
    current = await readPresentation(organizationId, productId);
  } catch {
    return fail("internal_error", t("Erro ao salvar o Ã¡udio."), 500, { requestId });
  }
  if (current?.updated_at !== mutation.data.expected_updated_at) return conflict(t, requestId);

  const raw = Buffer.from(await file.arrayBuffer());
  const normalized = isOggOpus(raw)
    ? { buffer: raw, mime: MIME_DO_AUDIO_DA_APRESENTACAO }
    : await transcodificarNotaDeVoz({ buffer: raw, mime: file.type || "application/octet-stream" });
  if (!isOggOpus(normalized.buffer)) {
    return fail("unsupported_media_type", t("O Ã¡udio precisa ser OGG/Opus ou WebM/Opus vÃ¡lido."), 415, {
      requestId,
      details: { content_type_declarado: file.type || null },
    });
  }

  const path = `${organizationId}/${productId}/${randomUUID()}.ogg`;
  const admin = createAdminClient();
  const { error: uploadError } = await admin.storage
    .from(BUCKET_DA_APRESENTACAO)
    .upload(path, normalized.buffer, {
      contentType: MIME_DO_AUDIO_DA_APRESENTACAO,
      upsert: false,
    });
  if (uploadError) {
    logger.error("[products/ai-presentation/audio] upload falhou", {
      detail: uploadError.message,
      requestId,
    });
    return fail("internal_error", t("Erro ao subir o Ã¡udio."), 500, { requestId });
  }

  const values = {
    audio_storage_path: path,
    audio_mime: MIME_DO_AUDIO_DA_APRESENTACAO,
    audio_size_bytes: normalized.buffer.length,
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
        .insert({
          organization_id: organizationId,
          catalog_product_id: productId,
          kind: "audio",
          ...values,
        })
        .select(PRESENTATION_COLUMNS)
        .maybeSingle();

  if (result.error || !result.data) {
    await removeCatalogPresentationAudio(organizationId, productId, path, requestId);
    if (result.error?.code === "23505" || !result.data) return conflict(t, requestId);
    return fail("internal_error", t("Erro ao salvar o Ã¡udio."), 500, { requestId });
  }
  if (current?.audio_storage_path) {
    await removeCatalogPresentationAudio(
      organizationId,
      productId,
      current.audio_storage_path,
      requestId,
    );
  }
  const saved = result.data as unknown as CatalogProductPresentationRow;
  const { data: signed } = await admin.storage
    .from(BUCKET_DA_APRESENTACAO)
    .createSignedUrl(path, 3600);
  await audit({
    organizationId,
    actorUserId: authz.user.id,
    action: "catalog_product.ai_presentation_audio_uploaded",
    resourceType: "catalog_products",
    resourceId: productId,
    requestId,
    metadata: { bytes: normalized.buffer.length, format: MIME_DO_AUDIO_DA_APRESENTACAO },
  });
  return ok(publicCatalogProductPresentation(saved, signed?.signedUrl ?? null), {
    requestId,
    status: 201,
  });
}

export async function DELETE(
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
  const parsedParams = paramsSchema.safeParse(await params);
  const parsedBody = catalogProductPresentationAudioMutationSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsedParams.success || !parsedBody.success) {
    return fail("validation_failed", t("Dados invÃ¡lidos."), 422, { requestId });
  }
  const productId = parsedParams.data.id;
  const organizationId = authz.org.orgId;
  if (!(await productExists(organizationId, productId))) {
    return fail("not_found", t("Produto nÃ£o encontrado."), 404, { requestId });
  }

  let current: CatalogProductPresentationRow | null;
  try {
    current = await readPresentation(organizationId, productId);
  } catch {
    return fail("internal_error", t("Erro ao remover o Ã¡udio."), 500, { requestId });
  }
  if (current?.updated_at !== parsedBody.data.expected_updated_at) return conflict(t, requestId);
  if (!current?.audio_storage_path) {
    return ok(publicCatalogProductPresentation(current), { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("catalog_product_presentations")
    .update({
      enabled: current.kind === "audio" ? false : current.enabled,
      audio_storage_path: null,
      audio_mime: null,
      audio_size_bytes: null,
    })
    .eq("organization_id", organizationId)
    .eq("catalog_product_id", productId)
    .eq("updated_at", current.updated_at)
    .select(PRESENTATION_COLUMNS)
    .maybeSingle();
  if (!error && !data) return conflict(t, requestId);
  if (error) return fail("internal_error", t("Erro ao remover o Ã¡udio."), 500, { requestId });

  await removeCatalogPresentationAudio(
    organizationId,
    productId,
    current.audio_storage_path,
    requestId,
  );
  await audit({
    organizationId,
    actorUserId: authz.user.id,
    action: "catalog_product.ai_presentation_audio_removed",
    resourceType: "catalog_products",
    resourceId: productId,
    requestId,
  });
  return ok(publicCatalogProductPresentation(data as unknown as CatalogProductPresentationRow), {
    requestId,
  });
}
