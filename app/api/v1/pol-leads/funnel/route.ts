/**
 * POST /api/v1/pol-leads/funnel
 *
 * Transicao de support_level de um pol_lead no funil politico.
 *
 * Valida que from_stage bate com o nivel atual, cria registro em
 * pol_funnel_transitions e atualiza pol_leads.support_level.
 *
 * Requer role manager.
 *
 * Seguranca: organization_id do cookie/JWT (fonte confiavel). Nunca do body.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// -- Validacao ----------------------------------------------------------------

const SUPPORT_LEVELS = [
  "novo_cadastro",
  "simpatizante",
  "apoiador",
  "militante",
  "voto_certo",
] as const;

const transicaoSchema = z.object({
  contact_id: z.string().uuid(),
  from_stage: z.enum(SUPPORT_LEVELS),
  to_stage: z.enum(SUPPORT_LEVELS),
  reason: z.string().max(500).optional(),
});

// -- POST — transicao de funil ------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_leads" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_leads.funnel_transition",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = transicaoSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { contact_id, from_stage, to_stage, reason } = parsed.data;

  if (from_stage === to_stage) {
    return fail("bad_request", "from_stage e to_stage devem ser diferentes", 400, { requestId });
  }

  const db = createAdminClient();

  // Buscar pol_lead atual pelo contact_id + organizacao
  const { data: polLead, error: errBusca } = await db
    .from("pol_leads")
    .select("id, support_level")
    .eq("contact_id", contact_id)
    .eq("organization_id", organizationId)
    .single();

  if (errBusca || !polLead) {
    return fail("not_found", "Pol_lead nao encontrado para este contato", 404, { requestId });
  }

  // Validar que from_stage bate com o nivel atual
  if (polLead.support_level !== from_stage) {
    return fail(
      "conflict",
      `Nivel atual e '${polLead.support_level}', nao '${from_stage}'`,
      409,
      { requestId },
    );
  }

  // Criar registro de transicao
  const { data: transicao, error: errTransicao } = await db
    .from("pol_funnel_transitions")
    .insert({
      organization_id: organizationId,
      contact_id,
      from_stage,
      to_stage,
      changed_by: userId,
      reason: reason ?? null,
    })
    .select()
    .single();

  if (errTransicao) {
    return fail("internal_error", "Erro ao registrar transicao", 500, { requestId });
  }

  // Atualizar support_level no pol_lead
  const { data: atualizado, error: errUpdate } = await db
    .from("pol_leads")
    .update({ support_level: to_stage })
    .eq("id", polLead.id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (errUpdate) {
    return fail("internal_error", "Erro ao atualizar support_level", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_leads.funnel_transition",
    resource_id: polLead.id,
    metadata: { contact_id, from_stage, to_stage, reason: reason ?? null, transition_id: transicao.id },
  });

  return ok(
    { pol_lead: atualizado, transition: transicao },
    { status: 201, headers: { "x-request-id": requestId } },
  );
}
