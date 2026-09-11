/**
 * GET/POST /api/v1/phone-numbers — números/DID de voz da org ativa.
 *
 * Espelha app/api/v1/calls/route.ts: `manager`+, RLS-scoped (createClient,
 * não admin), audit no create. `trunk_endpoint` nunca vem do body — é infra
 * compartilhada (mesmo Asterisk pra toda a plataforma hoje), não escolha da
 * organização; grava o valor de VOIP_TRUNK_ENDPOINT.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createPhoneNumberSchema } from "@/lib/schemas/phone-numbers";
import { validateRequest } from "@/lib/schemas/_validate";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// COLUMNS carrega o embed (join) pra LISTAGEM. Numa insert().select() o
// supabase-js não infere bem o tipo do embed junto da mutação -- MUTATION_COLUMNS
// devolve só as colunas próprias; o front reconsulta a lista via
// invalidateQueries de qualquer forma, então o `agent` populado chega no
// próximo GET, não precisa vir na resposta da mutação.
const COLUMNS =
  "id, number, label, routing_mode, default_ai_agent_id, is_active, created_at, " +
  "agent:ai_agents(id, name)";
const MUTATION_COLUMNS =
  "id, number, label, routing_mode, default_ai_agent_id, is_active, created_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "phone_numbers" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("phone_numbers")
    .select(COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: true });

  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "phone_numbers" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(createPhoneNumberSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const trunkEndpoint = process.env.VOIP_TRUNK_ENDPOINT;
  if (!trunkEndpoint) {
    return fail("voip_nao_configurado", "Troncal de voz não configurado no servidor.", 500, { requestId });
  }

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("phone_numbers")
    .insert({
      organization_id: activeOrg.orgId,
      number: input.number,
      label: input.label ?? null,
      trunk_endpoint: trunkEndpoint,
      routing_mode: input.routing_mode,
      default_ai_agent_id: input.default_ai_agent_id ?? null,
      is_active: input.is_active,
    })
    .select(MUTATION_COLUMNS)
    .single();

  if (error) {
    // uniq em `number` é GLOBAL (uma linha do trunk único, não por org) — 23505
    // aqui quase sempre é "esse DID já pertence a outra organização".
    if (error.code === "23505") {
      return fail("numero_ja_cadastrado", "Esse número já está cadastrado.", 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  await audit({
    action: "phone_number.created",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "phone_numbers",
    resourceId: row.id,
    requestId,
    metadata: { number: input.number },
  });

  return ok(row, { status: 201, requestId });
}
