/**
 * As agendas do Outlook de QUEM ESTÁ LOGADO e quais delas bloqueiam horário.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { PROVEDOR_MICROSOFT } from "@/lib/agenda/tipos";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "agenda" });
  if (!auth.ok) return auth.response;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  const db = await createClient();
  const org = auth.org.orgId;
  const falha = () => fail("internal_error", t("Não foi possível carregar suas agendas."), 500, { requestId });

  const { data: connections, error } = await db
    .from("calendar_connections")
    .select("id,account_email,status,last_sync_error")
    .eq("organization_id", org)
    .eq("user_id", auth.user.id)
    .eq("provider", PROVEDOR_MICROSOFT)
    .neq("status", "disconnected")
    .order("account_email");
  if (error) return falha();
  if (!connections?.length) return ok({ connections: [], calendars: [] }, { requestId });

  const { data: calendars, error: erroDasAgendas } = await db
    .from("calendar_connection_calendars")
    .select("id,connection_id,name,is_primary,counts_for_conflicts,last_sync_at,sync_error")
    .eq("organization_id", org)
    .eq("available", true)
    .in("connection_id", connections.map((c) => c.id))
    .order("name");
  if (erroDasAgendas) return falha();
  return ok({ connections, calendars: calendars ?? [] }, { requestId });
}

const escolha = z.object({ calendar_id: z.uuid(), counts_for_conflicts: z.boolean() }).strict();

export async function PATCH(req: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "agenda" });
  if (!auth.ok) return auth.response;
  const t = (texto: string) => traduzir(texto, auth.user.idioma);
  const lido = escolha.safeParse(await req.json().catch(() => null));
  if (!lido.success) return fail("validation_failed", t("Confira as agendas escolhidas."), 422, { requestId });

  // Service role (a tabela não aceita escrita da sessão): a posse é conferida
  // aqui — agenda desta organização, de uma conexão Outlook de quem pediu.
  const admin = createAdminClient();
  const org = auth.org.orgId;
  const { data: minhas, error } = await admin
    .from("calendar_connections")
    .select("id")
    .eq("organization_id", org)
    .eq("user_id", auth.user.id)
    .eq("provider", PROVEDOR_MICROSOFT)
    .neq("status", "disconnected");
  if (error) return fail("internal_error", t("Não foi possível salvar."), 500, { requestId });
  const ids = (minhas ?? []).map((c) => c.id);
  if (!ids.length) return fail("not_found", t("Agenda não encontrada."), 404, { requestId });

  const { data: alterada, error: erroAoGravar } = await admin
    .from("calendar_connection_calendars")
    .update({
      counts_for_conflicts: lido.data.counts_for_conflicts,
      // Marcar de novo exige leitura nova: sem cobertura antiga valendo como atual.
      sync_coverage: null,
      sync_next_attempt_at: new Date().toISOString(),
    })
    .eq("organization_id", org)
    .eq("id", lido.data.calendar_id)
    .eq("available", true)
    .in("connection_id", ids)
    .select("id")
    .maybeSingle();
  if (erroAoGravar) return fail("internal_error", t("Não foi possível salvar."), 500, { requestId });
  if (!alterada) return fail("not_found", t("Agenda não encontrada."), 404, { requestId });

  void audit({
    action: "agenda.microsoft.selecao_atualizada",
    organizationId: org,
    actorUserId: auth.user.id,
    resourceType: "calendar_connection_calendars",
    resourceId: alterada.id,
    requestId,
    metadata: { counts_for_conflicts: lido.data.counts_for_conflicts },
  });
  return ok({ saved: true }, { requestId });
}
