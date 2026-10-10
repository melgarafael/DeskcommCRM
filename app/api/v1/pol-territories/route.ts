/**
 * GET|POST /api/v1/pol-territories
 *
 * CRUD de territorios politicos — estados, cidades, bairros, zonas eleitorais, secoes, regioes e distritos.
 *
 * GET  — lista territorios da organizacao. Aceita ?type=, ?parent_id=, ?state_code=. Paginacao.
 * POST — cria um novo territorio. Requer role manager.
 *
 * Seguranca: organizacao resolvida do cookie/JWT (fonte confiavel). Nunca do body.
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

const criarTerritorySchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(TERRITORY_TYPES),
  parent_id: z.string().uuid().optional(),
  ibge_code: z.string().max(20).optional(),
  state_code: z.string().max(2).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  population: z.number().int().nonnegative().optional(),
  electorate: z.number().int().nonnegative().optional(),
});

// ── GET — listar territorios ─────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("viewer", { requestId, resource: "pol_territories" });
  if (!authz.ok) return authz.response;

  const { organizationId } = authz;
  const db = createAdminClient();
  const params = req.nextUrl.searchParams;

  let query = db
    .from("pol_territories")
    .select(
      "id, name, type, parent_id, ibge_code, state_code, latitude, longitude, population, electorate, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  // Filtros opcionais
  const type = params.get("type");
  if (type) query = query.eq("type", type);

  const parentId = params.get("parent_id");
  if (parentId) query = query.eq("parent_id", parentId);

  const stateCode = params.get("state_code");
  if (stateCode) query = query.eq("state_code", stateCode);

  // Paginacao simples
  const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 100);
  const offset = parseInt(params.get("offset") ?? "0", 10);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    return fail("internal_error", "Erro ao buscar territorios", 500, { requestId });
  }

  return ok(
    { territories: data ?? [] },
    {
      headers: { "x-request-id": requestId },
      meta: { total: count ?? (data?.length ?? 0), limit, offset },
    },
  );
}

// ── POST — criar territorio ──────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "pol_territories" });
  if (!authz.ok) return authz.response;

  const { organizationId, userId } = authz;

  const guardaSuporteWrite = await requireSupportWrite({ requestId, resource: "pol_territories.create" });
  if (!guardaSuporteWrite.ok) return guardaSuporteWrite.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "JSON invalido", 400, { requestId });
  }

  const parsed = criarTerritorySchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados invalidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = createAdminClient();

  // Se parent_id informado, verificar que pertence a mesma organizacao
  if (parsed.data.parent_id) {
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

  const { data: territory, error } = await db
    .from("pol_territories")
    .insert({
      organization_id: organizationId,
      name: parsed.data.name,
      type: parsed.data.type,
      parent_id: parsed.data.parent_id ?? null,
      ibge_code: parsed.data.ibge_code ?? null,
      state_code: parsed.data.state_code ?? null,
      latitude: parsed.data.latitude ?? null,
      longitude: parsed.data.longitude ?? null,
      population: parsed.data.population ?? null,
      electorate: parsed.data.electorate ?? null,
    })
    .select()
    .single();

  if (error) {
    return fail("internal_error", "Erro ao criar territorio", 500, { requestId });
  }

  // Audit log
  await db.from("api_audit_log").insert({
    organization_id: organizationId,
    user_id: userId,
    action: "pol_territories.create",
    resource_id: territory.id,
    metadata: { name: territory.name, type: territory.type },
  });

  return ok({ territory }, { status: 201, headers: { "x-request-id": requestId } });
}
