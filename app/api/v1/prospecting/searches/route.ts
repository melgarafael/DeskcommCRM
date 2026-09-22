/**
 * POST /api/v1/prospecting/searches — cria uma busca (job).
 * GET  /api/v1/prospecting/searches — lista com progresso.
 *
 * Criar valida, geocodifica (cidade→coordenadas), estima a grade e recusa
 * grade gigante (cap 2000 células — estado inteiro pede campanha fatiada).
 * Cache: mesmo hash dentro do TTL devolve a busca existente (reutilizada),
 * a menos que `forcar: true`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { gerarGrade } from "@/lib/prospeccao/grade";
import { hashDaBusca } from "@/lib/prospeccao/motor";
import { criarProvider } from "@/lib/prospeccao/providers/registro";
import { buscaCreateSchema } from "@/lib/schemas/prospeccao";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

const TETO_CELULAS = 2000;

async function chaveGoogle(admin: Awaited<ReturnType<typeof createAdminClient>>, orgId: string) {
  const { data } = await admin
    .from("prospecting_settings")
    .select("google_api_key_encrypted, cache_ttl_dias, limite_por_busca")
    .eq("organization_id", orgId)
    .maybeSingle();
  const cfg = data as unknown as {
    google_api_key_encrypted: string | null;
    cache_ttl_dias: number;
    limite_por_busca: number;
  } | null;
  let chave: string | null = null;
  if (cfg?.google_api_key_encrypted) {
    chave = await decryptWebhookSecret(admin, cfg.google_api_key_encrypted);
  }
  if (!chave) chave = process.env.GOOGLE_MAPS_API_KEY?.trim() || null;
  return { chave, ttl: cfg?.cache_ttl_dias ?? 30, teto: cfg?.limite_por_busca ?? 500 };
}

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "prospecting_searches" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospecting_searches")
    .select(
      "id, categorias, cidade, estado, raio_km, max_empresas, provider, status, " +
        "total_celulas, celulas_processadas, encontradas, novas, duplicadas, erros, " +
        "requisicoes, custo_estimado_cents, ultimo_erro, created_at, finished_at",
    )
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return fail("internal_error", "Erro ao listar as buscas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "prospecting_searches" });
  if (!authz.ok) return authz.response;

  const body = await req.json().catch(() => null);
  const parsed = buscaCreateSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const entrada = parsed.data;
  const forcar = (body as { forcar?: boolean } | null)?.forcar === true;

  if (entrada.provider === "maps_browser") {
    return fail(
      "validation_failed",
      "Provider via navegador desligado (esqueleto). Use osm_overpass (grátis) ou google_places.",
      422,
      { requestId },
    );
  }
  if (entrada.provider === "google_places" && process.env.GOOGLE_PLACES_ENABLED === "false") {
    return fail("validation_failed", "GOOGLE_PLACES_ENABLED=false nesta instalação.", 422, { requestId });
  }
  if (!entrada.cidade && (entrada.latitude == null || entrada.longitude == null)) {
    return fail("validation_failed", "Informe ao menos a cidade (busca estadual usa campanha).", 422, { requestId });
  }

  const admin = createAdminClient();
  const { chave, ttl, teto } = await chaveGoogle(admin, authz.org.orgId);
  if (entrada.provider === "google_places" && !chave) {
    return fail(
      "validation_failed",
      "Sem chave do Google (tenant e instalação). Configure em Configurações → Prospecção ou use osm_overpass (grátis).",
      422,
      { requestId },
    );
  }

  // Geocodifica AGORA (falha rápida, não job falho depois de 40 células).
  // OSM usa Nominatim (grátis); Google usa Geocoding (mesma chave).
  // Com coordenadas ("Buscar nesta área"), pula o geocode e usa o ponto.
  let geo: { latitude: number; longitude: number } | null = null;
  if (entrada.latitude != null && entrada.longitude != null) {
    geo = { latitude: entrada.latitude, longitude: entrada.longitude };
  } else {
    let provider;
    try {
      provider =
        entrada.provider === "osm_overpass"
          ? criarProvider("osm_overpass", {})
          : criarProvider("google_places", { chaveGoogle: chave ?? "" });
    } catch (e) {
      return fail("validation_failed", e instanceof Error ? e.message : String(e), 422, { requestId });
    }
    geo = (await provider
      .geocodificar?.(
        `${entrada.cidade}${entrada.estado ? `, ${entrada.estado}` : ""}, ${entrada.pais}`,
      )
      .catch(() => null)) ?? null;
  }
  if (!geo) {
    return fail("validation_failed", `Não achei "${entrada.cidade}" no mapa. Confira cidade/UF.`, 422, { requestId });
  }

  // Grade estimada antes de gravar: estado inteiro numa busca só é recusado
  // aqui, com número, em vez de travar a fila por dias.
  const { data: settings } = await admin
    .from("prospecting_settings")
    .select("grid_size_km, grid_overlap_pct")
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const cfg = (settings ?? {}) as { grid_size_km?: number; grid_overlap_pct?: number };
  const grade = gerarGrade(
    geo.latitude,
    geo.longitude,
    entrada.raio_km,
    Number(cfg.grid_size_km ?? 5),
    Number(cfg.grid_overlap_pct ?? 10),
  );
  const totalCelulas = grade.length * entrada.categorias.length;
  if (totalCelulas > TETO_CELULAS) {
    return fail(
      "validation_failed",
      `${totalCelulas} células — acima do teto de ${TETO_CELULAS}. Fatie em campanha (menos raio ou menos categorias por busca).`,
      422,
      { requestId },
    );
  }

  // Cache (§30): mesmo hash dentro do TTL reutiliza (sem reconsultar tudo).
  const hash = hashDaBusca({
    categorias: entrada.categorias,
    cidade: entrada.cidade ?? entrada.rotulo ?? null,
    estado: entrada.estado ?? null,
    raioKm: entrada.raio_km,
    provider: entrada.provider,
    latitude: entrada.latitude ?? null,
    longitude: entrada.longitude ?? null,
  });
  if (!forcar && ttl > 0) {
    const desde = new Date(Date.now() - ttl * 86400000).toISOString();
    const { data: recente } = await admin
      .from("prospecting_searches")
      .select("id, status")
      .eq("organization_id", authz.org.orgId)
      .eq("search_hash", hash)
      .eq("status", "completed")
      .gte("finished_at", desde)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recente) {
      return ok({ reutilizada: (recente as unknown as { id: string }).id }, { requestId });
    }
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("prospecting_searches")
    .insert({
      organization_id: authz.org.orgId,
      categorias: entrada.categorias,
      cidade: entrada.cidade ?? entrada.rotulo ?? null,
      estado: entrada.estado ?? null,
      pais: entrada.pais,
      latitude: geo.latitude,
      longitude: geo.longitude,
      raio_km: entrada.raio_km,
      max_empresas: Math.min(entrada.max_empresas, teto),
      provider: entrada.provider,
      campaign_id: entrada.campaign_id ?? null,
      status: "queued",
      grid_size_km: Number(cfg.grid_size_km ?? 5),
      grid_overlap_pct: Number(cfg.grid_overlap_pct ?? 10),
      total_celulas: totalCelulas,
      search_hash: hash,
      created_by: authz.user.id,
    })
    .select("id")
    .single();

  if (error || !data) {
    return fail("internal_error", "Erro ao criar a busca.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "prospecting_search.created",
    resourceType: "prospecting_searches",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok({ ...(data as unknown as Record<string, unknown>), total_celulas: totalCelulas }, { requestId, status: 201 });
}
