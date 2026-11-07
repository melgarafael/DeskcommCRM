/**
 * GET /api/v1/conversations/[id]/notes/[noteId]/media — acesso autenticado à
 * mídia ANEXADA À NOTA INTERNA (issue #1863, F3).
 *
 * Mesmo desenho da rota `/api/v1/messages/[id]/media`: 302 para signed URL do
 * Storage, usada diretamente como `src` de `<img>`/`<video>`/`<audio>` e como
 * `href` do card de documento (cookie de sessão vai junto por ser same-origin).
 *
 * Duas diferenças que são o motivo desta rota existir separada:
 *
 *   1. TTL CURTO — 60 s, contra 1 h da rota de mensagem. A mensagem pode ficar
 *      aberta na aba por horas e o browser refaz o request quando quer; a nota
 *      é lida em segundos e a URL assinada não precisa sobreviver a isso.
 *      URL longa para um arquivo que ninguém mais vai abrir é só janela para
 *      alguém com o link.
 *   2. Bucket `internal-media`, o bucket da nota — nunca `whatsapp-media`.
 *
 * A rota de nota (e não a de mensagem) é de propósito: anexo de nota não é
 * mensagem, não tem `messages.media_storage_path`, e serviria pelo caminho
 * errado. Quem não tem acesso à conversa não tem acesso à nota — é o mesmo
 * `fn_can_view_conversation` que a policy da nota aplica, e é ele quem o
 * `.eq("conversation_id")` + o filtro de org reproduzem aqui.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { comIdDaRequisicao, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * 60 s: a nota é lida e dispensada. O valor fica DEBAIXO do da rota de
 * mensagem (3600) de propósito — é a diferença entre "preciso ver o print que
 * anexei" e "esta aba vai ficar aberta o dia todo".
 */
const SIGNED_URL_TTL_S = 60;

interface RouteCtx {
  params: Promise<{ id: string; noteId: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversation_notes" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id: conversationId, noteId } = await ctx.params;

  const supabase = await createClient();

  // A conversa precisa existir e ser da org — antes de qualquer leitura de
  // nota, para não devolver 404 de nota em conversa de outro tenant como se a
  // nota não existisse (mesma honestidade da rota de lista).
  const { data: conversation, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (convErr) return fail("internal_error", t("Erro ao buscar conversa."), 500, { requestId });
  if (!conversation) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const { data: nota, error } = await supabase
    .from("conversation_notes")
    .select("id, conversation_id, media_storage_path")
    .eq("id", noteId)
    .eq("conversation_id", conversationId)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", t("Erro ao buscar nota."), 500, { requestId });
  if (!nota || !nota.media_storage_path) {
    // Nota sem anexo não é erro de servidor: não há o que servir.
    return fail("not_found", t("Nota sem anexo."), 404, { requestId });
  }

  const admin = createAdminClient();
  const { data: signed, error: signErr } = await admin.storage
    .from("internal-media")
    .createSignedUrl(nota.media_storage_path, SIGNED_URL_TTL_S);
  if (signErr || !signed?.signedUrl) {
    console.error("[conversations.notes.media] createSignedUrl failed", signErr?.message);
    return fail("internal_error", t("Erro ao abrir o arquivo."), 500, { requestId });
  }

  const response = comIdDaRequisicao(NextResponse.redirect(signed.signedUrl, 302), requestId);
  response.headers.set("X-Request-Id", requestId);
  // `private` porque o redirect é para um link assinado de 60 s: guardá-lo na
  // memória do browser além do TTL transformaria a curta em longa na prática.
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
