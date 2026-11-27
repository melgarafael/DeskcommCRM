/**
 * Desconecta a conta Microsoft: apaga os tokens, as agendas e a ocupação espelhada.
 * A própria pessoa com `agent`; a de outro membro exige `manager`.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { PROVEDOR_MICROSOFT } from "@/lib/agenda/tipos";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const corpo = z.object({ user_id: z.string().uuid().optional() });

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = req.headers.get("x-request-id") ?? undefined;

  const autorizado = await requireRole("agent", { requestId, resource: "calendar_connections" });
  if (!autorizado.ok) return autorizado.response;
  const t = (texto: string) => traduzir(texto, autorizado.user.idioma);
  const { user, org } = autorizado;

  const lido = corpo.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return fail("validation_failed", t("Corpo inválido para desconectar."), 422, { requestId });
  let alvo = user.id;
  if (lido.data.user_id && lido.data.user_id !== user.id) {
    const gestor = await requireRole("manager", { requestId, resource: "calendar_connections" });
    if (!gestor.ok) return gestor.response;
    alvo = lido.data.user_id;
  }

  const admin = createAdminClient();
  const { data: conexoes, error } = await admin
    .from("calendar_connections")
    .select("id")
    .eq("organization_id", org.orgId)
    .eq("user_id", alvo)
    .eq("provider", PROVEDOR_MICROSOFT)
    .neq("status", "disconnected");
  if (error) return fail("internal_error", t("Não foi possível desconectar."), 500, { requestId });
  if (!conexoes?.length)
    return fail("not_found", t("Não há agenda do Outlook conectada para esta pessoa."), 404, { requestId });
  const ids = conexoes.map((c) => c.id);

  // Status ANTES de apagar: a rodada em voo passa a ser recusada pelo banco e não
  // regrava o que estamos removendo.
  const desligada = await admin
    .from("calendar_connections")
    .update({
      status: "disconnected",
      oauth_access_token_encrypted: null,
      oauth_refresh_token_encrypted: null,
      token_expires_at: null,
      last_sync_error: null,
      catalog_retry_at: null,
    })
    .eq("organization_id", org.orgId)
    .in("id", ids);
  if (desligada.error) return fail("internal_error", t("Não foi possível desconectar."), 500, { requestId });
  for (const tabela of ["calendar_external_events", "calendar_connection_calendars"] as const) {
    const apagado = await admin.from(tabela).delete().eq("organization_id", org.orgId).in("connection_id", ids);
    if (apagado.error) return fail("internal_error", t("Não foi possível desconectar."), 500, { requestId });
  }

  for (const conexao of conexoes) {
    await audit({
      action: "agenda.microsoft.conexao_desconectada",
      organizationId: org.orgId,
      actorUserId: user.id,
      resourceType: "calendar_connections",
      resourceId: conexao.id,
      requestId,
      metadata: { user_id: alvo },
    });
  }
  return ok({ desconectadas: ids.length }, { requestId });
}
