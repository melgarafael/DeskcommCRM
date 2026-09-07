import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/media — upload outbound (multipart).
 * Storage-first: sobe pro bucket whatsapp-media; o envio da mensagem
 * referencia o storage_path (o WAHA recebe signed URL, nunca base64).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { extFromMime, MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { transcodificarNotaDeVoz } from "@/lib/messaging/media/voice-transcode";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: conversationId } = await ctx.params;
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only). Esta rota era a ÚNICA de
  // escrita em conversations/[id]/* sem o gate — e como a policy de SELECT deixa
  // o viewer enxergar toda conversa da org, o papel mais fraco do tenant tinha
  // escrita irrestrita no bucket (50 MB por arquivo, com service_role). A irmã
  // claim/route.ts:35 é o modelo literal.
  const authz = await requireRole("agent", { requestId, resource: "conversation_media" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const user = authz.user;
  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) return fail("no_active_org", t("No active organization."), 403, { requestId });

  // RLS + filtro explícito: a conversa precisa ser da org ativa.
  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", t("Erro ao validar conversa."), 500, { requestId });
  if (!conv) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  // Guard de DoS: rejeita pelo Content-Length declarado ANTES de bufferizar
  // o corpo inteiro. 1MB de slack pro overhead de multipart; o check
  // autoritativo continua o file.size pós-parse (Content-Length pode mentir).
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES + 1_048_576) {
    return fail("payload_too_large", t("Arquivo acima de 50MB."), 413, { requestId });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", t("Campo 'file' (multipart) obrigatório."), 422, { requestId });
  }

  const mime = file.type || "application/octet-stream";
  const verdict = validateOutboundMedia(mime, file.size);
  if (!verdict.ok) {
    const status = verdict.code === "payload_too_large" ? 413 : verdict.code === "unsupported_media_type" ? 415 : 422;
    return fail(verdict.code, verdict.message, status, { requestId });
  }

  const bruto = Buffer.from(await file.arrayBuffer());

  // Nota de voz gravada no browser sai em `webm` (o Chrome não grava ogg), e o
  // canal oficial recusa depois de aceitar — `131053 Media upload error`, que
  // culpa a URL quando o problema é o container. Converter AQUI faz todo canal
  // receber um arquivo válido, e o mesmo áudio poder ser reenviado depois sem
  // repetir o trabalho. Falha devolve o original: o canal que converte sozinho
  // continua funcionando como sempre.
  const audio = await transcodificarNotaDeVoz({ buffer: bruto, mime });
  const mimeFinal = audio.mime;
  const buffer = audio.buffer;

  const storagePath = `${activeOrg.orgId}/${conversationId}/out-${randomUUID()}.${extFromMime(mimeFinal)}`;
  const admin = createAdminClient();
  const { error: upErr } = await admin.storage
    .from("whatsapp-media")
    .upload(storagePath, buffer, { contentType: mimeFinal, upsert: false });
  if (upErr) {
    console.error("[conversations.media] upload failed", upErr.message);
    return fail("internal_error", t("Erro ao subir o arquivo."), 500, { requestId });
  }

  return ok(
    {
      storage_path: storagePath,
      // O mime e o tamanho do arquivo QUE FOI GUARDADO, não os que chegaram.
      // Devolver o original seria mandar o canal buscar um `webm` que já não
      // existe — o mesmo defeito, um passo adiante.
      media_mime: mimeFinal,
      media_size_bytes: buffer.length,
      kind: verdict.kind,
    },
    { requestId },
  );
}
