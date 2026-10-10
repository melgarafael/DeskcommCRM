/**
 * GET|PATCH|DELETE /api/v1/pol-territories/[id]
 *
 * Operacoes em um territorio politico especifico.
 *
 * GET    — detalhe do territorio com contagem de filhos e resumo de metricas (viewer+)
 * PATCH  — atualizar parcialmente (manager+)
 * DELETE — hard delete (admin only). Rejeita se existem territorios filhos.
 *
 * Seguranca: filtramos `organization_id` do cookie/JWT — nunca do body.
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

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// ── Validacao ──────────────────────────────────────────────────────────────────

const TERRITORY_TYPES = [
  "estado",
  "cidade",
  "bairro",
  "zona_eleitoral",
  "secao",
  "regiao",
  "distrito",
] as const;

const atualizarTerritorySchema = z
  .object({
    name: z.string().min(1).max(200),
    type: z.enum(TERRITORY_TYPES),
    parent_id: z.string().uuid().nullable(),
    ibge_code: z.string().max(20).nullable(),
    state_code: z.string().max(2).nullable(),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    population: z.number().int().nonnegative().nullable(),
    electorate: z.number().int().nonnegative().nullable(),
  })
  .partial(); // PATCH = todos opcionais

// ── Helpers ────────────────────────────────────────────────────────────────────

async function buscarTerritory(db: ReturnType<typeof createAdminClient>, id: string, organizationId: string) {
  return db
    .from("pol_territories")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .single();
}

// ── GET ────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "pol_territories" });
  if (!authz.ok) return authz.response;

  const db = createAdminClient();
  const { data: territory, error } = await buscarTerritory(db, id, authz.organizationId);

  if (error || !territory) {
    return fail("not_found", "Territorio nao encontrado", 404, { requestId });
  }

  // Contagem de filhos
  const { count: childCount } = await db
    .from("pol_territories")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.organizationId)
    .eq("parent_id", id);

  // Resumo de metricas: soma de populacao e eleitorado dos filhos diretos
  const { data: childMetrics } = await db
    .from("pol_territories")
    .select("population, electorate")
    .eq("organization_id", authz.organizationId)
    .eq("parent_id", id);

  const metricsSummary = {
    child_count: childCount ?? 0,
    children_population: (childMetrics ?? []).reduce((sum, c) => sum + (c.population ?? 0), 0),
    children_electorate: (childMetrics ?? []).reduce((sum, c) => sum + (c.electorate ?? 0), 0),
  };

  return ok({ territory, metrics: metricsSummary }, { headers: { "x-request-id": requestId } });
}

// ── PATCH ──────────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "pol_territories" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_territories.update",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = atualizarTerritorySchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  if (Object.keys(parsed.data).length === 0) {
    return fail("bad_request", "Nenhum campo para atualizar", 400, { requestId });
  }

  const db = createAdminClient();

  // Verificar existencia + tenant
  const { data: existente, error: errBusca } = await buscarTerritory(db, id, organizationId);
  if (errBusca || !existente) {
    return fail("not_found", "Territorio nao encontrado", 404, { requestId });
  }

  // Se parent_id informado, verificar que pertence a mesma organizacao e nao e o proprio
  if (parsed.data.parent_id !== undefined && parsed.data.parent_id !== null) {
    if (parsed.data.parent_id === id) {
      return fail("bad_request", "Territorio nao pode ser pai de si mesmo", 400, { requestId });
    }

    const { data: parent, error: errParent } = await db
      .from("pol_territories")
      .select("id")
      .eq("id", parsed.data.parent_id)
      .eq("organization_id", organizationId)
      .single();

    if (errParent || !parent) {
      return fail("not_found", "Territorio pai nao encontrado", 404, { requestId });
    }
  }

  const { data: atualizado, error: errUpdate } = await db
    .from("pol_territories")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select()
    .single();

  if (errUpdate) {
    return fail("internal_error", "Erro ao atualizar territorio", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_territories.update",
    resource_id: id,
    metadata: { campos_alterados: Object.keys(parsed.data) },
  });

  return ok({ territory: atualizado }, { headers: { "x-request-id": requestId } });
}

// ── DELETE ─────────────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "pol_territories" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({
    requestId,
    resource: "pol_territories.delete",
  });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  const db = createAdminClient();

  const { data: existente, error: errBusca } = await buscarTerritory(db, id, organizationId);
  if (errBusca || !existente) {
    return fail("not_found", "Territorio nao encontrado", 404, { requestId });
  }

  // Rejeitar se existem territorios filhos
  const { count: childCount } = await db
    .from("pol_territories")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("parent_id", id);

  if (childCount && childCount > 0) {
    return fail("conflict", "Territorio possui filhos e nao pode ser removido. Remova os filhos primeiro.", 409, {
      requestId,
      details: { child_count: childCount },
    });
  }

  // Hard delete
  const { error: errDelete } = await db
    .from("pol_territories")
    .delete()
    .eq("id", id)
    .eq("organization_id", organizationId);

  if (errDelete) {
    return fail("internal_error", "Erro ao deletar territorio", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_territories.delete",
    resource_id: id,
    metadata: { name: existente.name, type: existente.type },
  });

  return ok({ deleted: true }, { headers: { "x-request-id": requestId } });
}
