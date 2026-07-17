/**
 * POST /api/v1/ai/knowledge/sources/upload
 *
 * Multipart upload for policy files (PDF or Markdown, max 20MB).
 * Uploads to private `ai-policy` bucket, inserts ai_knowledge_sources row,
 * validates extraction inline, and emits knowledge_source.updated event.
 *
 * Auth: cookie session. Role >= manager required.
 * organization_id is resolved from JWT — NEVER from request body.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestPolicyFile, PdfExtractError } from "@/lib/ai/rag/ingest/policy";

export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/markdown",
  "text/x-markdown",
  "text/plain", // some systems send .md as text/plain
]);

const ALLOWED_EXTENSIONS = new Set(["pdf", "md"]);

function resolveExt(filename: string, mimeType: string): "pdf" | "md" | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "md") return "md";
  // Fallback by MIME
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/markdown" || mimeType === "text/x-markdown") return "md";
  return null;
}

const nameSchema = z.string().min(2).max(120);
const agentIdSchema = z.string().uuid();

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // --- Auth ---
  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  // --- Parse multipart ---
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return fail("invalid_request", "Falha ao processar multipart/form-data.", 400, { requestId });
  }

  const fileEntry = formData.get("file");
  const agentIdRaw = formData.get("agent_id");
  const nameRaw = formData.get("name");

  if (!(fileEntry instanceof File)) {
    return fail("invalid_request", "Campo 'file' ausente ou inválido.", 400, { requestId });
  }

  // --- Validate agent_id and name ---
  const agentIdParsed = agentIdSchema.safeParse(agentIdRaw);
  if (!agentIdParsed.success) {
    return fail("validation_failed", "Campo 'agent_id' deve ser UUID válido.", 422, { requestId });
  }
  const nameParsed = nameSchema.safeParse(nameRaw);
  if (!nameParsed.success) {
    return fail("validation_failed", "Campo 'name' inválido (2-120 chars).", 422, { requestId });
  }

  const agentId = agentIdParsed.data;
  const name = nameParsed.data;
  const file = fileEntry;

  // --- File size check ---
  if (file.size > MAX_FILE_SIZE) {
    return fail("payload_too_large", "Arquivo excede o limite de 20MB.", 413, { requestId });
  }

  // --- MIME / extension validation ---
  const mimeType = file.type;
  const ext = resolveExt(file.name, mimeType);

  const isMimeAllowed =
    ALLOWED_MIME_TYPES.has(mimeType) ||
    ALLOWED_EXTENSIONS.has(file.name.split(".").pop()?.toLowerCase() ?? "");

  if (!isMimeAllowed || !ext) {
    return fail(
      "unsupported_media_type",
      "Tipo de arquivo não suportado. Envie PDF ou Markdown (.pdf, .md).",
      415,
      { requestId },
    );
  }

  // --- Validate agent belongs to org (user-scoped client, RLS enforces tenant) ---
  const supabase = await createClient();
  const { data: agent, error: agentErr } = await supabase
    .from("ai_agents")
    .select("id")
    .eq("id", agentId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (agentErr) {
    console.error("[ai-policy-upload] agent lookup failed:", agentErr.message);
    return fail("internal_error", "Erro ao validar agent_id.", 500, { requestId });
  }
  if (!agent) {
    return fail("not_found", "Agent não encontrado nesta organização.", 404, { requestId });
  }

  // --- Upload to Storage ---
  const blobId = randomUUID();
  const blobPath = `${activeOrg.orgId}/${blobId}.${ext}`;
  const admin = createAdminClient();

  const fileBuffer = Buffer.from(await file.arrayBuffer());

  const { error: uploadErr } = await admin.storage
    .from("ai-policy")
    .upload(blobPath, fileBuffer, { contentType: mimeType, upsert: false });

  if (uploadErr) {
    console.error("[ai-policy-upload] storage upload failed:", uploadErr.message);
    return fail("internal_error", "Erro ao fazer upload do arquivo.", 500, { requestId });
  }

  // --- Validate extraction inline before committing the DB row ---
  // A failed extraction triggers cleanup of the blob we just uploaded.
  let chunkCount = 0;
  try {
    // We don't have a knowledgeSourceId yet; pass a placeholder — ingestPolicyFile
    // only uses it for logging when the ks row already exists.
    const result = await ingestPolicyFile({
      organizationId: activeOrg.orgId,
      agentId,
      knowledgeSourceId: "pre-insert-validation",
      blobPath,
      ext,
    });
    chunkCount = result.chunkCount;
  } catch (err) {
    // Cleanup uploaded blob
    await admin.storage.from("ai-policy").remove([blobPath]);

    if (err instanceof PdfExtractError) {
      return fail(
        "unprocessable_entity",
        "Não foi possível extrair texto do PDF. Verifique se o arquivo não é somente imagens.",
        422,
        { requestId },
      );
    }
    console.error("[ai-policy-upload] extraction failed:", err);
    return fail("internal_error", "Erro ao processar o arquivo.", 500, { requestId });
  }

  // --- Insert ai_knowledge_sources ---
  const sourceMetadata = {
    filename: file.name,
    blob_path: blobPath,
    version: 1,
    uploaded_by: authUser.id,
    mime_type: mimeType,
    size_bytes: file.size,
    chunk_count: chunkCount,
  };

  const { data: ks, error: ksErr } = await admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: activeOrg.orgId,
      agent_id: agentId,
      source_type: "policy",
      name,
      status: "ready",
      ingested_at: new Date().toISOString(),
      source_metadata: sourceMetadata,
    })
    .select("id")
    .single();

  if (ksErr || !ks) {
    // Cleanup blob
    await admin.storage.from("ai-policy").remove([blobPath]);
    console.error("[ai-policy-upload] insert knowledge source failed:", ksErr?.message);
    return fail("internal_error", "Erro ao registrar fonte de conhecimento.", 500, { requestId });
  }

  const ksId = (ks as { id: string }).id;

  // --- Emit knowledge_source.updated event (fire-and-forget) ---
  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: ksId,
    p_payload: {
      knowledge_source_id: ksId,
      agent_id: agentId,
      source_type: "policy",
    },
    p_organization_id: activeOrg.orgId,
  } as never);

  if (emitErr) {
    console.warn("[ai-policy-upload] emit_event failed (non-blocking):", emitErr.message);
  }

  return ok({ data: { id: ksId, blob_path: blobPath } }, { status: 201, requestId });
}
