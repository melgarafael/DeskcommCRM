import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/messages/[id]/document-intake
 * Atribui a mídia de uma mensagem a uma Pessoa do Advomax.
 * A operação é idempotente por (organization_id, message_id).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { requeueDocumentIntake } from "@/lib/crm/document-intake";

export const dynamic = "force-dynamic";

interface RouteCtx { params: Promise<{ id: string }> }

const bodySchema = z.object({
  pessoa_codigo: z.coerce.number().int().positive(),
  descricao: z.string().trim().max(1000).optional(),
}).strict();

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const { id: messageId } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "document_intake" });
  if (!authz.ok) return authz.response;

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return fail("validation_failed", "Informe uma Pessoa válida.", 422, { requestId });

  const supabase = await createClient();
  const { data: message, error: messageError } = await supabase
    .from("messages")
    .select("id, conversation_id, contact_id, media_storage_path, media_mime, type")
    .eq("id", messageId)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (messageError) return fail("internal_error", "Não foi possível validar a mídia.", 500, { requestId });
  if (!message) return fail("not_found", "Mensagem não encontrada.", 404, { requestId });
  if (!message.media_storage_path) return fail("validation_failed", "Esta mensagem ainda não tem mídia persistida.", 422, { requestId });

  // O vínculo confirmado do contato é a fonte de verdade. Permitir que um
  // atendente troque silenciosamente a Pessoa aqui arquivaria o documento na
  // pasta jurídica errada; contato sem vínculo ainda pode ser atribuído
  // manualmente, e o vínculo pode ser confirmado separadamente pelo gerente.
  if (message.contact_id) {
    const { data: link, error: linkError } = await supabase
      .from("advomax_contact_links" as never)
      .select("pessoa_codigo,status")
      .eq("organization_id", authz.org.orgId)
      .eq("contact_id", message.contact_id)
      .maybeSingle();
    if (linkError) return fail("internal_error", "Não foi possível validar o vínculo jurídico.", 500, { requestId });
    const typedLink = link as { pessoa_codigo: number; status: string } | null;
    if (typedLink?.status === "linked" && typedLink.pessoa_codigo !== parsed.data.pessoa_codigo) {
      return fail("conflict", "O contato já está vinculado a outra Pessoa do Advomax.", 409, { requestId });
    }
  }

  const payload = {
    organization_id: authz.org.orgId,
    message_id: message.id,
    conversation_id: message.conversation_id,
    contact_id: message.contact_id,
    pessoa_codigo: parsed.data.pessoa_codigo,
    filename: filenameFor(message.type, message.media_mime),
    mime_type: message.media_mime ?? "application/octet-stream",
    media_storage_path: message.media_storage_path,
    descricao: parsed.data.descricao ?? null,
    requested_by: authz.user.id,
    status: "pending",
  };

  const { data: existing, error: existingError } = await supabase
    .from("crm_document_intake" as never)
    .select("*")
    .eq("organization_id", authz.org.orgId)
    .eq("message_id", messageId)
    .maybeSingle();
  if (existingError) return fail("internal_error", "Não foi possível consultar a atribuição.", 500, { requestId });
  if (existing && (existing as { status?: string }).status === "uploaded") return ok(existing, { requestId });

  let intake: unknown = existing;
  if (existing) {
    const { data: requeued, error: requeueError } = await supabase
      .from("crm_document_intake" as never)
      .update(requeueDocumentIntake(parsed.data.pessoa_codigo, parsed.data.descricao) as never)
      .eq("id", (existing as { id: string }).id)
      .eq("organization_id", authz.org.orgId)
      .select("*")
      .single();
    if (requeueError) return fail("internal_error", "Não foi possível reprocessar a atribuição.", 500, { requestId });
    intake = requeued;
  } else {
    const { data: inserted, error: insertError } = await supabase
      .from("crm_document_intake" as never)
      .insert(payload as never)
      .select("*")
      .single();
    if (insertError) {
      if (insertError.code === "23505") {
        const { data: raced } = await supabase.from("crm_document_intake" as never).select("*").eq("organization_id", authz.org.orgId).eq("message_id", messageId).single();
        if (raced) return ok(raced, { requestId });
      }
      return fail("internal_error", "Não foi possível registrar a atribuição.", 500, { requestId });
    }
    intake = inserted;
    await audit({
      action: "document_intake.created",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "crm_document_intake",
      resourceId: (inserted as { id: string }).id,
      requestId,
      metadata: { message_id: messageId, pessoa_codigo: parsed.data.pessoa_codigo },
    });
  }

  // A ponte é síncrona quando configurada; sem configuração a linha fica
  // pending e a tela consegue explicar o próximo passo ao administrador.
  if (env.ADVOMAX_API_URL.trim() && env.ADVOMAX_CRM_INTEGRATION_KEY.trim()) {
    const admin = createAdminClient();
    const { data: blob, error: downloadError } = await admin.storage
      .from("whatsapp-media")
      .download(message.media_storage_path);
    if (downloadError || !blob) return marcarFalha(supabase, intake, requestId, "Mídia não disponível no Storage.");

    const form = new FormData();
    form.append("file", new File([blob], payload.filename, { type: payload.mime_type }));
    if (payload.descricao) form.append("descricao", payload.descricao);
    const base = env.ADVOMAX_API_URL.replace(/\/$/, "");
    const response = await fetch(`${base}/integracoes/crm/pessoas/${payload.pessoa_codigo}/documentos`, {
      method: "POST",
      headers: {
        "X-CRM-Integration-Key": env.ADVOMAX_CRM_INTEGRATION_KEY,
        "X-CRM-User-Email": authz.user.email,
        "X-CRM-Organization-Id": authz.org.orgId,
        "X-CRM-Message-Id": messageId,
      },
      body: form,
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (!response || !response.ok) {
      return marcarFalha(supabase, intake, requestId, "Advomax não confirmou o arquivamento.");
    }
    const advomax = await response.json().catch(() => ({})) as { codigo?: number };
    const { data: atualizado, error: updateError } = await supabase
      .from("crm_document_intake" as never)
      .update({ status: "uploaded", advomax_file_id: advomax.codigo ?? null, failure_reason: null } as never)
      .eq("id", (intake as { id: string }).id)
      .eq("organization_id", authz.org.orgId)
      .select("*")
      .single();
    if (updateError) return fail("internal_error", "Documento arquivado, mas o recibo não foi atualizado.", 500, { requestId });
    await audit({ action: "document_intake.uploaded", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "crm_document_intake", resourceId: (intake as { id: string }).id, requestId });
    return ok(atualizado, { requestId });
  }

  return ok(intake, { requestId });
}

function filenameFor(type: string | null, mime: string | null): string {
  const ext = mime?.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return `whatsapp-${type || "arquivo"}.${ext}`;
}

async function marcarFalha(supabase: Awaited<ReturnType<typeof createClient>>, intake: unknown, requestId: string, motivo: string): Promise<Response> {
  const row = intake as { id: string; organization_id: string; attempts?: number };
  const attempts = (row.attempts ?? 0) + 1;
  const terminal = attempts >= 5;
  await supabase.from("crm_document_intake" as never).update({
    status: terminal ? "failed" : "pending",
    attempts,
    next_attempt_at: new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000).toISOString(),
    failure_reason: motivo,
  } as never).eq("id", row.id).eq("organization_id", row.organization_id);
  return fail("bad_gateway", motivo, 502, { requestId });
}
