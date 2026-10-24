/**
 * GET /api/v1/leads/[id]/attachments/[attachmentId]/media — acesso autenticado à
 * mídia anexada ao negócio / lead.
 *
 * Mesmo desenho canônico da rota `/api/v1/conversations/[id]/notes/[noteId]/media`:
 * 302 para signed URL do Supabase Storage no bucket `internal-media`, com TTL
 * curto (60 s) e `Cache-Control: private, no-store`.
 *
 * Isso garante que o link nunca expira no banco de dados e nenhum token de 30
 * dias fique salvo permanentemente.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { isLeadAttachmentPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SIGNED_URL_TTL_S = 60;
const BUCKET = "internal-media";

interface RouteCtx {
  params: Promise<{ id: string; attachmentId: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;
  const { id: leadId, attachmentId } = await ctx.params;

  const supabase = await createClient();

  // Garante que o lead existe e pertence à organização da sessão
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id")
    .eq("id", leadId)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (leadErr) return fail("internal_error", t("Erro ao buscar negócio."), 500, { requestId });
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  // Busca o anexo na tabela crm_lead_attachments
  const { data: anexo, error: anexoErr } = await supabase
    .from("crm_lead_attachments")
    .select("id, storage_path")
    .eq("id", attachmentId)
    .eq("lead_id", leadId)
    .eq("organization_id", org.orgId)
    .maybeSingle();

  if (anexoErr) return fail("internal_error", t("Erro ao buscar anexo."), 500, { requestId });
  if (!anexo || !anexo.storage_path) {
    return fail("not_found", t("Anexo não encontrado."), 404, { requestId });
  }
  // O link sai com o cliente admin: só assina o que mora sob o prefixo deste negócio.
  if (!isLeadAttachmentPathOwnedBy(anexo.storage_path, org.orgId, lead.id)) {
    logger.warn("[leads/attachments] caminho fora do negócio; link não assinado", { attachmentId, requestId });
    return fail("not_found", t("Anexo não encontrado."), 404, { requestId });
  }

  const admin = createAdminClient();
  const { data: signed, error: signErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(anexo.storage_path, SIGNED_URL_TTL_S);

  if (signErr || !signed?.signedUrl) {
    return fail("internal_error", t("Erro ao gerar link do arquivo."), 500, { requestId });
  }

  const response = NextResponse.redirect(signed.signedUrl, 302);
  response.headers.set("X-Request-Id", requestId);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
