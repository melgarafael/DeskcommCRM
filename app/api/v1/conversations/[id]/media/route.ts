/**
 * POST /api/v1/conversations/[id]/media — upload outbound (multipart).
 * Storage-first: sobe pro bucket whatsapp-media; o envio da mensagem
 * referencia o storage_path (o WAHA recebe signed URL, nunca base64).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { extFromMime } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) return fail("no_active_org", "No active organization.", 403, { requestId });

  // RLS + filtro explícito: a conversa precisa ser da org ativa.
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", "Erro ao validar conversa.", 500, { requestId });
  if (!conv) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", "Campo 'file' (multipart) obrigatório.", 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  const verdict = validateOutboundMedia(mime, file.size);
  if (!verdict.ok) {
    const status = verdict.code === "payload_too_large" ? 413 : verdict.code === "unsupported_media_type" ? 415 : 422;
    return fail(verdict.code, verdict.message, status, { requestId });
  }

  const storagePath = `${activeOrg.orgId}/${conversationId}/out-${randomUUID()}.${extFromMime(mime)}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  const admin = createAdminClient();
  const { error: upErr } = await admin.storage
    .from("whatsapp-media")
    .upload(storagePath, buffer, { contentType: mime, upsert: false });
  if (upErr) {
    console.error("[conversations.media] upload failed", upErr.message);
    return fail("internal_error", "Erro ao subir o arquivo.", 500, { requestId });
  }

  return ok(
    {
      storage_path: storagePath,
      media_mime: mime,
      media_size_bytes: file.size,
      kind: verdict.kind,
    },
    { requestId },
  );
}
