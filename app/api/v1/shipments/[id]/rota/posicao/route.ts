/**
 * POST /api/v1/shipments/[id]/rota/posicao — o GPS do motorista.
 * GET  /api/v1/shipments/[id]/rota/posicoes — o rastro (mapa + realizado).
 *
 * O ping só vale com a carga `em_rota`: fora dela é recusado (privacidade —
 * o rastreio existe durante a rota, com o login do motorista, e morre com
 * ela). Sem audit por ping (frequência); a rota guarda quem/quando no
 * started_by/started_at. Teto de 500 pontos por carga (o mapa e o realizado
 * não precisam de mais; o resto é custo).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  precisao_m: z.number().min(0).max(100000).nullable().optional(),
});

const TETO_POR_CARGA = 500;

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "shipments" });
  if (!authz.ok) return authz.response;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const { id } = await params;
  const supabase = await createClient();
  const { data: carga } = await supabase
    .from("shipments")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .single();
  if (!carga) return fail("not_found", "Carga não encontrada.", 404, { requestId });
  if ((carga as unknown as { status: string }).status !== "em_rota") {
    return fail("validation_failed", "Rastreio só com rota em andamento.", 422, { requestId });
  }

  const { error } = await supabase.from("shipment_positions").insert({
    organization_id: authz.org.orgId,
    shipment_id: id,
    latitude: parsed.data.latitude,
    longitude: parsed.data.longitude,
    precisao_m: parsed.data.precisao_m ?? null,
    por: authz.user.id,
  });
  if (error) return fail("internal_error", "Erro ao registrar a posição.", 500, { requestId });

  // Poda: mantém os 500 mais novos, apaga o resto numa ida só.
  const { data: excedentes } = await supabase
    .from("shipment_positions")
    .select("id")
    .eq("shipment_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("em", { ascending: false })
    .range(TETO_POR_CARGA, TETO_POR_CARGA + 100);
  const idsFora = ((excedentes ?? []) as unknown as { id: string }[]).map((p) => p.id);
  if (idsFora.length > 0) {
    await supabase.from("shipment_positions").delete().in("id", idsFora).eq("organization_id", authz.org.orgId);
  }

  return ok({ ok: true }, { requestId });
}

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "shipments" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const limite = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limite") ?? 200), 1), 1000);
  const supabase = await createClient();
  const { data } = await supabase
    .from("shipment_positions")
    .select("latitude, longitude, precisao_m, em")
    .eq("shipment_id", id)
    .eq("organization_id", authz.org.orgId)
    .order("em", { ascending: true })
    .limit(limite);

  return ok({ posicoes: data ?? [] }, { requestId });
}
