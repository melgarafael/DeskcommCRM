import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { MODULO_AVALIACAO_NAO_INSTALADO, moduloAvaliacaoNaoInstalado } from "@/lib/avaliacao/modulo";
import { atualizarAgendamentoSchema } from "@/lib/avaliacao/schemas";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const SELECT =
  "id, contact_id, lead_id, unit_id, consultant_user_id, attendant_user_id, scheduled_at, duration_minutes, client_email, vehicle_plate, vehicle_brand, vehicle_model, notes, status, evaluation_started_at, cancelled_at, evaluated_at, contacts(name, phone_number), avaliacao_unidades(name)";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) return fail("not_found", "Not found", 404, { requestId });

  const authz = await requireRole("viewer", { requestId, resource: "avaliacao_agendamentos" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase.from("avaliacao_agendamentos").select(SELECT).eq("id", id).maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Agendamento não encontrado.", 404, { requestId });
  return ok(data, { requestId });
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) return fail("not_found", "Not found", 404, { requestId });

  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("agent", { requestId, resource: "avaliacao_agendamentos" });
  if (!authz.ok) return authz.response;

  const body = atualizarAgendamentoSchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return fail("validation_failed", body.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }
  if (body.data.status) {
    return fail("validation_failed", "Use a rota de ações para mudar o status.", 422, { requestId });
  }

  const patch = { ...body.data, updated_at: new Date().toISOString() };
  delete (patch as { status?: string }).status;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("avaliacao_agendamentos")
    .update(patch)
    .eq("id", id)
    .select(SELECT)
    .maybeSingle();

  if (error) {
    if (moduloAvaliacaoNaoInstalado(error)) {
      return fail("module_not_installed", MODULO_AVALIACAO_NAO_INSTALADO, 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) return fail("not_found", "Agendamento não encontrado.", 404, { requestId });

  void audit({
    action: "avaliacao.agendamento_atualizado",
    resourceType: "avaliacao_agendamento",
    resourceId: id,
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
  });

  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "avaliacao"))) return fail("not_found", "Not found", 404, { requestId });

  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const authz = await requireRole("manager", { requestId, resource: "avaliacao_agendamentos" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data: row } = await supabase.from("avaliacao_agendamentos").select("status").eq("id", id).maybeSingle();
  if (!row) return fail("not_found", "Agendamento não encontrado.", 404, { requestId });
  if (row.status === "em_avaliacao") {
    return fail("conflict", "Não é possível excluir um agendamento em avaliação.", 409, { requestId });
  }

  const { error } = await supabase.from("avaliacao_agendamentos").delete().eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "avaliacao.agendamento_excluido",
    resourceType: "avaliacao_agendamento",
    resourceId: id,
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
  });

  return ok({ id }, { requestId });
}
