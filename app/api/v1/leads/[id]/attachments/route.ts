import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const BUCKET = "internal-media";
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const SIGNED_URL_EXPIRES = 60 * 60 * 24 * 30; // 30 dias

const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/jpg",
]);

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export interface LeadAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  type: string;
  url: string;
  uploaded_at: string;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: leadId } = await ctx.params;
  const orgId = authz.org.orgId;

  const form = await req.formData().catch(() => null);
  if (!form) {
    return fail("validation_failed", t("Requisição multipart inválida."), 400, { requestId });
  }

  const file = form.get("file");
  const fieldKey = form.get("field_key");

  if (!(file instanceof File)) {
    return fail("validation_failed", t("Arquivo não informado."), 422, { requestId });
  }

  if (typeof fieldKey !== "string" || !fieldKey.trim()) {
    return fail("validation_failed", t("Campo ('field_key') não informado."), 422, { requestId });
  }

  if (file.size > MAX_BYTES) {
    return fail("payload_too_large", t("O arquivo excede o limite de 50 MB."), 413, { requestId });
  }

  if (!ALLOWED_MIMES.has(file.type.toLowerCase())) {
    return fail("unsupported_media_type", t("Formato inválido. Envie PDF ou imagem (PNG, JPG, WebP)."), 415, {
      requestId,
      details: { mime: file.type },
    });
  }

  const safeName = sanitizeFileName(file.name);
  const attachmentId = randomUUID();
  const ext = safeName.includes(".") ? safeName.split(".").pop() : "bin";
  const storagePath = `${orgId}/leads/${leadId}/${fieldKey}/${attachmentId}.${ext}`;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const admin = createAdminClient();

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType: file.type, upsert: false });

  if (uploadError) {
    logger.error("[leads/attachments] upload falhou", { detalhe: uploadError.message, requestId });
    return fail("internal_error", t("Falha ao salvar arquivo no armazenamento."), 500, { requestId });
  }

  const { data: signedData, error: signedError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRES);

  const fileUrl = signedData?.signedUrl ?? "";

  const attachment: LeadAttachment = {
    id: attachmentId,
    name: file.name,
    path: storagePath,
    size: file.size,
    type: file.type,
    url: fileUrl,
    uploaded_at: new Date().toISOString(),
  };

  // Atualizar custom_fields do lead no banco
  const supabase = await createClient();
  const { data: leadData, error: readLeadErr } = await supabase
    .from("crm_leads")
    .select("custom_fields")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (readLeadErr || !leadData) {
    return fail("not_found", t("Lead não encontrado."), 404, { requestId });
  }

  const customFields = (leadData.custom_fields as Record<string, unknown> | null) ?? {};
  const currentFiles = Array.isArray(customFields[fieldKey])
    ? (customFields[fieldKey] as LeadAttachment[])
    : [];

  const updatedFiles = [...currentFiles, attachment];
  customFields[fieldKey] = updatedFiles;

  const { error: updateErr } = await supabase
    .from("crm_leads")
    .update({ custom_fields: customFields })
    .eq("id", leadId)
    .eq("organization_id", orgId);

  if (updateErr) {
    logger.error("[leads/attachments] update custom_fields falhou", { detalhe: updateErr.message, requestId });
    return fail("internal_error", t("Falha ao vincular arquivo ao negócio."), 500, { requestId });
  }

  return ok({ attachment, files: updatedFiles }, { status: 201, requestId });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: leadId } = await ctx.params;
  const orgId = authz.org.orgId;

  let body: { field_key?: string; attachment_id?: string };
  try {
    body = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo JSON inválido."), 400, { requestId });
  }

  const { field_key: fieldKey, attachment_id: attachmentId } = body;
  if (!fieldKey || !attachmentId) {
    return fail("validation_failed", t("field_key e attachment_id são obrigatórios."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data: leadData, error: readLeadErr } = await supabase
    .from("crm_leads")
    .select("custom_fields")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (readLeadErr || !leadData) {
    return fail("not_found", t("Lead não encontrado."), 404, { requestId });
  }

  const customFields = (leadData.custom_fields as Record<string, unknown> | null) ?? {};
  const currentFiles = Array.isArray(customFields[fieldKey])
    ? (customFields[fieldKey] as LeadAttachment[])
    : [];

  const target = currentFiles.find((f) => f.id === attachmentId);
  const updatedFiles = currentFiles.filter((f) => f.id !== attachmentId);
  customFields[fieldKey] = updatedFiles;

  // Remover do Storage se encontrado
  if (target?.path) {
    const admin = createAdminClient();
    await admin.storage.from(BUCKET).remove([target.path]).catch((e) => {
      logger.warn("[leads/attachments] falha ao apagar do storage", { path: target.path, erro: e?.message });
    });
  }

  const { error: updateErr } = await supabase
    .from("crm_leads")
    .update({ custom_fields: customFields })
    .eq("id", leadId)
    .eq("organization_id", orgId);

  if (updateErr) {
    return fail("internal_error", t("Falha ao atualizar anexos."), 500, { requestId });
  }

  return ok({ files: updatedFiles }, { requestId });
}
