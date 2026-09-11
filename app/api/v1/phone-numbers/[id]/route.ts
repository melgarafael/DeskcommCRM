/**
 * PATCH /api/v1/phone-numbers/[id] — edita um número já cadastrado.
 *
 * `number` e `trunk_endpoint` não são editáveis por aqui de propósito: trocar
 * o DID em produção silenciosamente é o tipo de mudança que quebra roteamento
 * sem ninguém perceber até a próxima ligação perdida — quem quiser um número
 * diferente cadastra outro e desativa este.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { updatePhoneNumberSchema } from "@/lib/schemas/phone-numbers";
import { validateRequest } from "@/lib/schemas/_validate";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Ver nota em ../route.ts: o embed de agent não infere bem tipo em
// update().select() -- a resposta do PATCH devolve só colunas próprias.
const MUTATION_COLUMNS =
  "id, number, label, routing_mode, default_ai_agent_id, is_active, created_at";

type RouteCtx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "phone_numbers" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;
  const { id } = await ctx.params;

  let input;
  try {
    input = await validateRequest(updatePhoneNumberSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  if (Object.keys(input).length === 0) {
    return fail("validation_failed", "Nada para atualizar.", 422, { requestId });
  }

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("phone_numbers")
    .update(input)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .select(MUTATION_COLUMNS)
    .maybeSingle();

  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!row) return fail("not_found", "Número não encontrado.", 404, { requestId });

  await audit({
    action: "phone_number.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "phone_numbers",
    resourceId: id,
    requestId,
    metadata: input,
  });

  return ok(row, { requestId });
}
