/**
 * POST /api/v1/shipments/[id]/rota/manual — o operador marca no mapa.
 *
 * `{ contact_id, latitude, longitude }`: grava o cache como `ok/manual`.
 * Só vale para contato COM parada nesta carga — o body não inventa destino.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { carregarCargaComParadas } from "../_carga";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  contact_id: z.string().uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
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
  const d = await carregarCargaComParadas(supabase, authz.org.orgId, id);
  if (!d) return fail("not_found", "Carga não encontrada.", 404, { requestId });
  if (!d.paradas.some((p) => p.contact_id === parsed.data.contact_id)) {
    return fail("validation_failed", "Contato sem parada nesta carga.", 422, { requestId });
  }

  const { error } = await supabase
    .from("contacts")
    .update({
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      geo_status: "ok",
      geo_em: new Date().toISOString(),
      geo_fonte: "manual",
    })
    .eq("id", parsed.data.contact_id)
    .eq("organization_id", authz.org.orgId);
  if (error) return fail("internal_error", "Erro ao gravar a posição.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "shipment.rota.posicao_manual",
    resourceType: "shipments",
    resourceId: id,
    requestId,
  });

  return ok({ contact_id: parsed.data.contact_id }, { requestId });
}
