import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { clientIp, paginaDeSaida } from "@/lib/plataformas-de-anuncio/pagina-de-captura";
import { destinoDoLink, type LinkRastreavel } from "@/lib/plataformas-de-anuncio/rastreio/links";
import { comIdDaRequisicao } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await ctx.params).id);
  if (!id.success) return comIdDaRequisicao(paginaDeSaida(null), req);
  const ip = clientIp(req);
  if (ip && !(await checkRateLimit(`rastreio:${id.data}:${ip}`, 30, 60)).allowed)
    return comIdDaRequisicao(new NextResponse(null, {
      status: 429,
      headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    }), req);
  const admin = createAdminClient();
  // UUID público identifica o link; a organização só vem da linha persistida.
  const { data, error } = await admin
    .from("ad_tracking_links")
    .select("id,organization_id,name,whatsapp_e164,message_template,use_case,utm,enabled")
    .eq("id", id.data)
    .eq("enabled", true)
    .maybeSingle();
  if (error || !data) return comIdDaRequisicao(paginaDeSaida(null), req);
  const destino = await destinoDoLink(admin, data as LinkRastreavel, new URL(req.url).searchParams);
  const response = comIdDaRequisicao(paginaDeSaida(destino), req);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
