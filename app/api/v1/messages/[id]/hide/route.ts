/** Ocultar uma mensagem recebida apenas no CRM, sem prometer exclusão no WhatsApp do cliente. */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { lerMencoesDeGrupo, textoComMencoesResolvidas } from "@/lib/messaging/mencoes-de-grupo";
import { previaDaMensagem } from "@/lib/messaging/previa-da-mensagem";

interface Ctx { params: Promise<{ id: string }> }

async function alterar(req: NextRequest, ctx: Ctx, ocultar: boolean): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "messages",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "messages_hide", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }
  const supabase = authz.supabase;
  const { data: message, error } = await supabase.from("messages")
    .select("id, organization_id, conversation_id, direction, body, type, metadata, revoked_at")
    .eq("id", id).eq("organization_id", authz.organizationId).maybeSingle();
  if (error) return fail("internal_error", t("Erro ao buscar mensagem."), 500, { requestId });
  if (!message) return fail("not_found", t("Mensagem não encontrada."), 404, { requestId });
  if (message.direction !== "inbound" || message.revoked_at) {
    return fail("forbidden", t("Esta mensagem não pode ser ocultada."), 403, { requestId });
  }
  const anterior = (message.metadata ?? {}) as Record<string, unknown>;
  const metadata = { ...anterior };
  if (ocultar) {
    metadata.crm_hidden_at = new Date().toISOString();
    metadata.crm_hidden_by = authz.actor.type === "user" ? authz.actor.id : null;
  } else {
    delete metadata.crm_hidden_at;
    delete metadata.crm_hidden_by;
  }
  const { data: updated, error: updateError } = await supabase.from("messages")
    .update({ metadata }).eq("id", id).eq("organization_id", authz.organizationId)
    .select("id, metadata").maybeSingle();
  if (updateError || !updated) {
    return fail("internal_error", t("Não foi possível atualizar a mensagem."), 500, { requestId });
  }

  // O preview desnormalizado no painel lateral não pode continuar expondo o
  // texto oculto. Só o alteramos se esta ainda for a última mensagem da conversa.
  const { data: latest } = await supabase.from("messages").select("id")
    .eq("organization_id", authz.organizationId).eq("conversation_id", message.conversation_id)
    .order("sent_at", { ascending: false }).limit(1).maybeSingle();
  if (latest?.id === id) {
    // A régua do filtro é a MESMA que gravou a coluna: em grupo, a ingestão grava
    // a prévia com a menção já resolvida (`@Maria`, #3566). Recalcular do corpo
    // cru (`@<lid>`) faria o compare-and-set não achar a linha — a rota responde
    // 200 e a lista segue mostrando o texto que o gestor acabou de ocultar.
    const antigoPreview = previaDaMensagem(
      textoComMencoesResolvidas(message.body, lerMencoesDeGrupo(message.metadata)),
      message.type,
    );
    await supabase.from("conversations").update({
      last_message_preview: ocultar ? "Mensagem ocultada no CRM" : antigoPreview,
    }).eq("id", message.conversation_id).eq("organization_id", authz.organizationId)
      .eq("last_message_preview", ocultar ? antigoPreview : "Mensagem ocultada no CRM");
  }
  await audit({
    action: ocultar ? "message.hidden_in_crm" : "message.restored_in_crm",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
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
