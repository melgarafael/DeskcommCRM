/** Retirada manual preserva o histórico e impede os próximos passos. */
import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { cadenciasLigadas } from "@/lib/cadencias/modulo";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; inscricaoId: string }> }): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "cadencias" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  if (!(await cadenciasLigadas(admin, authz.org.orgId))) return fail("not_found", "Módulo indisponível.", 404, { requestId });
  const { id, inscricaoId } = await ctx.params;
  const { data, error } = await admin.from("email_cadence_enrollments").update({ status: "parada", motivo_parada: "manual", rastreio_consentido: false, processando_ate: null, processamento_id: null, parada_em: new Date().toISOString() }).eq("organization_id", authz.org.orgId).eq("cadence_id", id).eq("id", inscricaoId).eq("status", "ativa").select("id, lead_id").maybeSingle();
  if (error) return fail("internal_error", "Não foi possível retirar a inscrição.", 500, { requestId });
  if (!data) return fail("not_found", "Inscrição ativa não encontrada.", 404, { requestId });
  await admin.from("email_cadence_events").insert({ organization_id: authz.org.orgId, cadence_id: id, enrollment_id: data.id, lead_id: data.lead_id, tipo: "parada", ator_user_id: authz.user.id });
  void audit({ action: "cadencia.lead_retirado", actorUserId: authz.user.id, organizationId: authz.org.orgId, resourceType: "email_cadence_enrollment", resourceId: data.id, requestId });
  return ok({ id: data.id, status: "parada" }, { requestId });
}
