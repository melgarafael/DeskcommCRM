/**
 * GET /api/v1/commercial-goals — metas do mês (leitura: viewer+).
 * PUT /api/v1/commercial-goals — define a meta (escrita: manager+).
 *
 * O denominador do dashboard: sem linha aqui, "61,5% da meta" seria número
 * mágico. `vendedor_user_id` ausente = meta DA LOJA; com UUID = individual.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ANO_MES = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

const putSchema = z.object({
  ano_mes: z.string().regex(ANO_MES, "ano_mes usa YYYY-MM"),
  valor_cents: z.number().int().min(0).max(1_000_000_000_00),
  vendedor_user_id: z.string().uuid().nullable().optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_goals" });
  if (!authz.ok) return authz.response;

  const anoMes = req.nextUrl.searchParams.get("ano_mes")?.trim() ?? "";
  if (!ANO_MES.test(anoMes)) {
    return fail("validation_failed", "Passe ?ano_mes=YYYY-MM.", 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("commercial_goals")
    .select("vendedor_user_id, valor_cents")
    .eq("organization_id", authz.org.orgId)
    .eq("ano_mes", anoMes);

  if (error) return fail("internal_error", "Erro ao ler as metas.", 500, { requestId });
  return ok((data ?? []) as { vendedor_user_id: string | null; valor_cents: number }[], {
    requestId,
  });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "commercial_goals" });
  if (!authz.ok) return authz.response;

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { ano_mes, valor_cents, vendedor_user_id = null } = parsed.data;

  // Sem onConflict: os índices únicos são PARCIAIS (loja vs. vendedor) e NULL
  // não colide — update-then-insert pelo predicado exato de cada regime.
  const supabase = await createClient();
  let q = supabase
    .from("commercial_goals")
    .update({ valor_cents })
    .eq("organization_id", authz.org.orgId)
    .eq("ano_mes", ano_mes);
  q = vendedor_user_id ? q.eq("vendedor_user_id", vendedor_user_id) : q.is("vendedor_user_id", null);
  const atualizado = await q.select("id");

  if (atualizado.error) {
    return fail("internal_error", "Erro ao salvar a meta.", 500, { requestId });
  }
  if ((atualizado.data ?? []).length === 0) {
    const { error: erroInsert } = await supabase.from("commercial_goals").insert({
      organization_id: authz.org.orgId,
      ano_mes,
      valor_cents,
      vendedor_user_id,
    });
    if (erroInsert) {
      return fail("internal_error", "Erro ao salvar a meta.", 500, { requestId });
    }
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "commercial_goal.saved",
    resourceType: "commercial_goals",
    resourceId: null,
    requestId,
  });

  return ok({ ano_mes, valor_cents, vendedor_user_id }, { requestId });
}
