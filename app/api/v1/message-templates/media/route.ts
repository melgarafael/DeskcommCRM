import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/message-templates/media — upload do áudio de um recurso (#2833).
 * Multipart; agent+. Sobe para o bucket `recursos-media` sob
 * `{org}/recursos/{uuid}.{ext}` e devolve o `storage_path` — o caminho que o
 * recurso guarda e que o compositor assina (GET /message-templates/[id]) na
 * hora de armar o anexo pendente. Nada aqui envia mensagem.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { extFromMime } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
/** Bucket dos arquivos de recurso (migration 0662). */
const BUCKET_DE_RECURSOS = "recursos-media";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  const verdict = validateOutboundMedia(mime, file.size);
  if (!verdict.ok) {
    const status =
      verdict.code === "payload_too_large" ? 413 : verdict.code === "unsupported_media_type" ? 415 : 422;
    return fail(verdict.code, verdict.message, status, { requestId });
  }
  // Recurso de áudio é áudio: recusar imagem/vídeo aqui evita uma biblioteca
  // que promete "áudio" e guarda qualquer coisa.
  if (verdict.kind !== "audio") {
    return fail(
      "unsupported_media_type",
      t("O recurso de áudio aceita apenas arquivos de áudio."),
      415,
      { requestId },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const storagePath = `${org.orgId}/recursos/${randomUUID()}.${extFromMime(mime)}`;
  const admin = createAdminClient();
  const { error: upErr } = await admin.storage
    .from(BUCKET_DE_RECURSOS)
    .upload(storagePath, buffer, { contentType: mime, upsert: false });
  if (upErr) {
    console.error("[message-templates.media] upload failed", upErr.message);
    return fail("internal_error", t("Erro ao subir o arquivo."), 500, { requestId });
  }

  return ok(
    { storage_path: storagePath, media_mime: mime, media_size_bytes: buffer.length },
    { requestId, status: 201 },
  );
}
