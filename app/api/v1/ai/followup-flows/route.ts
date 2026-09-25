import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/followup-flows — lista pointers da org ativa (any member).
 * POST /api/v1/ai/followup-flows — cria draft (manager+). Nasce status='draft',
 *   draft_graph null, trigger_config default 'manual' (default do banco).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createFollowupFlowSchema } from "@/lib/followup/api-schemas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const LIST_COLUMNS = "id, name, status, active_version_id, handoff_policy, updated_at";

/**
 * `?surface=atendimento` lista os roteiros de atendimento (a tela deles chega no
 * PR 3). Sem o parâmetro, só os fluxos do RELÓGIO — a tela de Follow-ups, o
 * seletor de fluxos do agente e a ação de webhook "inscrever" leem daqui, e na
 * prova prática do #1130 os roteiros apareciam nessas listas como se fossem
 * follow-ups (e abriam no editor de follow-up).
 */
export async function GET(req?: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const querRoteiros = req?.nextUrl.searchParams.get("surface") === "atendimento";
  const supabase = await createClient();
  const base = supabase
    .from("followup_flow_pointers")
    .select(LIST_COLUMNS)
    .eq("organization_id", activeOrg.orgId);
  const { data, error } = await (querRoteiros
    ? base.eq("surface", "atendimento")
    : base.neq("surface", "atendimento")
  ).order("updated_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = createFollowupFlowSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // Roteiro de atendimento é módulo opcional da instalação (doc 64): desligado,
  // a porta não existe — 404, a mesma resposta do banco externo desligado.
  if (
    parsed.data.surface === "atendimento" &&
    !(await moduloLigado(createAdminClient(), "fluxos_atendimento"))
  ) {
    return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });
  }

  const supabase = await createClient();
  const { data: created, error: insErr } = await supabase
    .from("followup_flow_pointers")
    .insert({
      organization_id: activeOrg.orgId,
      name: parsed.data.name,
      ...(parsed.data.surface !== undefined ? { surface: parsed.data.surface } : {}),
    })
    .select("*")
    .single();

  if (insErr || !created) {
    if (insErr?.code === "23505") {
      return fail("conflict", t("Já existe um fluxo com este nome."), 409, { requestId });
    }
    return fail("internal_error", insErr?.message ?? "followup_flow_insert_failed", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.created",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: created.id,
    requestId,
    metadata: { name: parsed.data.name },
  });

  return ok(created, { requestId, status: 201 });
}
