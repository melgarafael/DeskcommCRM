import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { settingsDoFunil } from "@/lib/leads/campos-exigidos";
import { camposDoFunil, escopoDoCampo } from "@/lib/leads/campos-do-funil";
import { customFieldSchema } from "@/lib/schemas/settings";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { isLeadAttachmentPathOwnedBy } from "@/lib/messaging/media/upload-validation";

export const dynamic = "force-dynamic";

const BUCKET = "internal-media";
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

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
  created_at?: string;
  uploaded_at?: string;
}

// A MESMA régua da chave que o funil aceita ao cadastrar o campo: a chave entra
// no caminho do objeto no Storage.
const PostSchema = z.object({
  field_key: customFieldSchema.shape.key,
});

const DeleteSchema = z.object({
  field_key: z.string().trim().min(1, "field_key é obrigatório."),
  attachment_id: z.string().uuid("attachment_id inválido."),
});

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function serializarAnexo(row: {
  id: string;
  file_name: string;
  storage_path: string;
  file_size: number | string;
  mime_type: string;
  created_at: string;
}, leadId: string): LeadAttachment {
  return {
    id: row.id,
    name: row.file_name,
    path: row.storage_path,
    size: Number(row.file_size) || 0,
    type: row.mime_type,
    url: `/api/v1/leads/${leadId}/attachments/${row.id}/media`,
    created_at: row.created_at,
    uploaded_at: row.created_at,
  };
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id: leadId } = await ctx.params;
  const orgId = authz.org.orgId;

  const url = new URL(req.url);
  const fieldKey = url.searchParams.get("field_key");

  const supabase = await createClient();

  // Verifica existência e posse do lead
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (leadErr || !lead) {
    return fail("not_found", t("Lead não encontrado."), 404, { requestId });
  }

  let query = supabase
    .from("crm_lead_attachments")
    .select("id, file_name, storage_path, file_size, mime_type, created_at")
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .order("created_at", { ascending: true });

  if (fieldKey) {
    query = query.eq("field_key", fieldKey);
  }

  const { data: rows, error: rowsErr } = await query;
  if (rowsErr) {
    logger.error("[leads/attachments] erro ao listar anexos", { error: rowsErr.message, requestId });
    return fail("internal_error", t("Falha ao buscar anexos."), 500, { requestId });
  }

  const files = (rows ?? []).map((r) => serializarAnexo(r, leadId));
  return ok({ files }, { requestId });
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
  const rawFieldKey = form.get("field_key");

  const parsed = PostSchema.safeParse({ field_key: rawFieldKey });
  if (!parsed.success) {
    return fail("validation_failed", parsed.error.issues[0]?.message ?? t("Parâmetro inválido."), 422, {
      requestId,
    });
  }

  const { field_key: fieldKey } = parsed.data;

  if (!(file instanceof File)) {
    return fail("validation_failed", t("Arquivo não informado."), 422, { requestId });
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

  const supabase = await createClient();
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, pipeline_id")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (leadErr || !lead) {
    return fail("not_found", t("Lead não encontrado."), 404, { requestId });
  }

  // Só se anexa a um campo `file` do NEGÓCIO que o funil deste lead declara.
  const settings = await settingsDoFunil(supabase, lead.pipeline_id);
  const campo = camposDoFunil(settings as Record<string, unknown> | null).find(
    (c) => c.key === fieldKey,
  );
  if (!campo || campo.type !== "file" || escopoDoCampo(campo) !== "negocio") {
    return fail("validation_failed", t("Este funil não tem um campo de arquivo com essa chave."), 422, {
      requestId,
    });
  }

  const safeName = sanitizeFileName(file.name);
  const attachmentId = randomUUID();
  const ext = safeName.includes(".") ? safeName.split(".").pop() : "bin";
  // `lead.id` (do banco), não o parâmetro da URL: o banco confere o caminho
  // contra `lead_id::text`, sempre minúsculo.
  const storagePath = `${orgId}/leads/${lead.id}/${fieldKey}/${attachmentId}.${ext}`;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const admin = createAdminClient();

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType: file.type, upsert: false });

  if (uploadError) {
    logger.error("[leads/attachments] upload falhou", { detalhe: uploadError.message, requestId });
    return fail("internal_error", t("Falha ao salvar arquivo no armazenamento."), 500, { requestId });
  }

  // Grava na tabela crm_lead_attachments
  const { data: inserted, error: insertError } = await supabase
    .from("crm_lead_attachments")
    .insert({
      id: attachmentId,
      organization_id: orgId,
      lead_id: leadId,
      field_key: fieldKey,
      file_name: file.name,
      file_size: file.size,
      mime_type: file.type,
      storage_path: storagePath,
      created_by: authz.user.id,
    })
    .select("id, file_name, storage_path, file_size, mime_type, created_at")
    .single();

  if (insertError || !inserted) {
    logger.error("[leads/attachments] insert falhou", { detalhe: insertError?.message, requestId });
    // Tenta limpar o arquivo enviado para não deixar lixo no Storage
    await admin.storage.from(BUCKET).remove([storagePath]).catch(() => null);
    return fail("internal_error", t("Falha ao registrar anexo no banco de dados."), 500, { requestId });
  }

  await audit({
    action: "lead.attachment_uploaded",
    resourceType: "crm_leads",
    resourceId: leadId,
    metadata: {
      attachment_id: attachmentId,
      field_key: fieldKey,
      file_name: file.name,
      file_size: file.size,
      mime_type: file.type,
    },
    requestId,
  });

  const attachment = serializarAnexo(inserted, leadId);

  // Busca todos os arquivos deste campo para devolver a lista atualizada
  const { data: allRows } = await supabase
    .from("crm_lead_attachments")
    .select("id, file_name, storage_path, file_size, mime_type, created_at")
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .eq("field_key", fieldKey)
    .order("created_at", { ascending: true });

  const files = (allRows ?? []).map((r) => serializarAnexo(r, leadId));
  return ok({ attachment, files }, { status: 201, requestId });
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo JSON inválido."), 400, { requestId });
  }

  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", parsed.error.issues[0]?.message ?? t("Parâmetros inválidos."), 422, {
      requestId,
    });
  }

  const { field_key: fieldKey, attachment_id: attachmentId } = parsed.data;

  const supabase = await createClient();

  // Mesmo portão do GET/POST/mídia: o negócio tem de ser visível para quem pede.
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (leadErr || !lead) {
    return fail("not_found", t("Lead não encontrado."), 404, { requestId });
  }

  // Busca o anexo existente
  const { data: anexo, error: readErr } = await supabase
    .from("crm_lead_attachments")
    .select("id, storage_path, file_name")
    .eq("id", attachmentId)
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (readErr || !anexo) {
    return fail("not_found", t("Anexo não encontrado."), 404, { requestId });
  }
  // A remoção do arquivo é com o cliente admin: só sob o prefixo deste negócio.
  if (anexo.storage_path && !isLeadAttachmentPathOwnedBy(anexo.storage_path, orgId, lead.id)) {
    logger.warn("[leads/attachments] caminho fora do negócio; nada removido", { attachmentId, requestId });
    return fail("not_found", t("Anexo não encontrado."), 404, { requestId });
  }

  // Remove do Storage
  const admin = createAdminClient();
  if (anexo.storage_path) {
    await admin.storage.from(BUCKET).remove([anexo.storage_path]).catch((e) => {
      logger.warn("[leads/attachments] falha ao apagar do storage", { path: anexo.storage_path, erro: e?.message });
    });
  }

  // Remove do banco
  const { error: delErr } = await supabase
    .from("crm_lead_attachments")
    .delete()
    .eq("id", attachmentId)
    .eq("lead_id", leadId)
    .eq("organization_id", orgId);

  if (delErr) {
    logger.error("[leads/attachments] delete falhou", { detalhe: delErr.message, requestId });
    return fail("internal_error", t("Falha ao remover anexo."), 500, { requestId });
  }

  await audit({
    action: "lead.attachment_deleted",
    resourceType: "crm_leads",
    resourceId: leadId,
    metadata: {
      attachment_id: attachmentId,
      field_key: fieldKey,
      file_name: anexo.file_name,
    },
    requestId,
  });

  // Retorna a lista restante
  const { data: remainingRows } = await supabase
    .from("crm_lead_attachments")
    .select("id, file_name, storage_path, file_size, mime_type, created_at")
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .eq("field_key", fieldKey)
    .order("created_at", { ascending: true });

  const files = (remainingRows ?? []).map((r) => serializarAnexo(r, leadId));
  return ok({ files }, { requestId });
}
