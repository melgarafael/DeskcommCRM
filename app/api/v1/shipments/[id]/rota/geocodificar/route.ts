/**
 * POST /api/v1/shipments/[id]/rota/geocodificar — resolve endereços no servidor.
 *
 * Body `{ contact_ids?: string[] }` (vazio = todos os pendentes da carga,
 * máx 20 por chamada — ritmo justo de 1,1s com a instância pública). Grava o
 * cache em `contacts` (ok|nao_encontrado|ambiguo|erro) e devolve os estados
 * para a tela mostrar "corrigir" ou "marcar no mapa".
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { geocodificarComFallback } from "@/lib/rotas/geocodificacao";
import { createClient } from "@/lib/supabase/server";

import { carregarCargaComParadas } from "../_carga";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  contact_ids: z.array(z.string().uuid()).max(20).optional(),
});

// 10 por chamada: cada contato pode custar até 6 consultas (cadeia de
// fallback × 1,1s de ritmo justo) — lote maior estouraria o timeout da rota.
const MAXIMO_POR_CHAMADA = 10;

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
  if (d.paradas.length === 0) return fail("validation_failed", "Carga sem pedidos.", 422, { requestId });

  const alvos = d.paradas.filter(
    (p) =>
      p.contact_id &&
      p.endereco &&
      (p.latitude == null || p.longitude == null) &&
      (!parsed.data.contact_ids || parsed.data.contact_ids.includes(p.contact_id)),
  );

  // Só contatos desta carga — o body não inventa destino.
  const { data: contatos } = await supabase
    .from("contacts")
    .select("id, logradouro, numero_end, complemento, bairro, cidade, uf, cep")
    .eq("organization_id", authz.org.orgId)
    .in(
      "id",
      alvos.map((a) => a.contact_id as string).slice(0, MAXIMO_POR_CHAMADA),
    );
  const porId = new Map(
    ((contatos ?? []) as unknown as Record<string, string | null>[]).map((c) => [c.id as string, c]),
  );

  const estados: { contact_id: string; estado: string }[] = [];
  for (const alvo of alvos.slice(0, MAXIMO_POR_CHAMADA)) {
    const c = porId.get(alvo.contact_id as string);
    if (!c) continue;
    const s = (k: string) => (c[k] as string | null) ?? null;
    // Cadeia de fallback (rua+número → expandida → sem número): cada fase
    // existe por um envenenamento medido — número com "sala03", "65, 65"
    // colado, "R CEL" abreviado, "LOJA" no bairro.
    const r = await geocodificarComFallback(
      {
        logradouro: s("logradouro"),
        numero_end: s("numero_end"),
        bairro: s("bairro"),
        cidade: s("cidade"),
        uf: s("uf"),
      },
      alvo.endereco as string,
    );
    const patch =
      r.estado === "ok"
        ? {
            latitude: r.latitude,
            longitude: r.longitude,
            geo_status: "ok",
            geo_em: new Date().toISOString(),
            geo_fonte: `nominatim:${r.precisao ?? "rua"}`,
          }
        : { latitude: null, longitude: null, geo_status: r.estado, geo_em: new Date().toISOString(), geo_fonte: "nominatim" };
    await supabase.from("contacts").update(patch).eq("id", alvo.contact_id).eq("organization_id", authz.org.orgId);
    estados.push({ contact_id: alvo.contact_id as string, estado: r.estado });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "shipment.rota.geocodificada",
    resourceType: "shipments",
    resourceId: id,
    requestId,
  });

  return ok({ estados, restantes: Math.max(0, alvos.length - estados.length) }, { requestId });
}
