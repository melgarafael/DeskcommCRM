/** Ocultar uma mensagem recebida apenas no CRM, sem prometer exclusão no WhatsApp do cliente. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

interface Ctx { params: Promise<{ id: string }> }

async function alterar(req: NextRequest, ctx: Ctx, ocultar: boolean): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }
  const supabase = await createClient();
  const { data: message, error } = await supabase.from("messages")
    .select("id, organization_id, conversation_id, direction, body, type, metadata, revoked_at")
    .eq("id", id).eq("organization_id", authz.org.orgId).maybeSingle();
  if (error) return fail("internal_error", t("Erro ao buscar mensagem."), 500, { requestId });
  if (!message) return fail("not_found", t("Mensagem não encontrada."), 404, { requestId });
  if (message.direction !== "inbound" || message.revoked_at) {
    return fail("forbidden", t("Esta mensagem não pode ser ocultada."), 403, { requestId });
  }
  const anterior = (message.metadata ?? {}) as Record<string, unknown>;
  const metadata = { ...anterior };
  if (ocultar) {
    metadata.crm_hidden_at = new Date().toISOString();
    metadata.crm_hidden_by = authz.user.id;
  } else {
    delete metadata.crm_hidden_at;
    delete metadata.crm_hidden_by;
  }
  const { data: updated, error: updateError } = await supabase.from("messages")
    .update({ metadata }).eq("id", id).eq("organization_id", authz.org.orgId)
    .select("id, metadata").maybeSingle();
  if (updateError || !updated) {
    return fail("internal_error", t("Não foi possível atualizar a mensagem."), 500, { requestId });
  }

  // O preview desnormalizado no painel lateral não pode continuar expondo o
  // texto oculto. Só o alteramos se esta ainda for a última mensagem da conversa.
  const { data: latest } = await supabase.from("messages").select("id")
    .eq("organization_id", authz.org.orgId).eq("conversation_id", message.conversation_id)
    .order("sent_at", { ascending: false }).limit(1).maybeSingle();
  if (latest?.id === id) {
    const antigoPreview = message.body?.slice(0, 280) || `[${message.type}]`;
    await supabase.from("conversations").update({
      last_message_preview: ocultar ? "Mensagem ocultada no CRM" : antigoPreview,
    }).eq("id", message.conversation_id).eq("organization_id", authz.org.orgId)
      .eq("last_message_preview", ocultar ? antigoPreview : "Mensagem ocultada no CRM");
  }
  await audit({
    action: ocultar ? "message.hidden_in_crm" : "message.restored_in_crm",
    actorUserId: authz.user.id, organizationId: authz.org.orgId,
    resourceType: "message", resourceId: id, requestId,
    metadata: { conversation_id: message.conversation_id },
  });
  return ok(updated, { requestId });
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return alterar(req, ctx, true);
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return alterar(req, ctx, false);
}
