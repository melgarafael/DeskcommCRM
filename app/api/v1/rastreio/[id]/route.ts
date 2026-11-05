import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { clientIp, paginaDeSaida } from "@/lib/plataformas-de-anuncio/pagina-de-captura";
import { destinoDoLink, type LinkRastreavel } from "@/lib/plataformas-de-anuncio/rastreio/links";
import { rotaComIdDaRequisicao } from "@/lib/api/id-da-requisicao";

export const dynamic = "force-dynamic";
export const GET = rotaComIdDaRequisicao(rotaGET);

async function rotaGET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = z.uuid().safeParse((await ctx.params).id);
  if (!id.success) return paginaDeSaida(null);
  const ip = clientIp(req);
  if (ip && !(await checkRateLimit(`rastreio:${id.data}:${ip}`, 30, 60)).allowed)
    return new NextResponse(null, {
      status: 429,
      headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    });
  const admin = createAdminClient();
  // UUID público identifica o link; a organização só vem da linha persistida.
  const { data, error } = await admin
    .from("ad_tracking_links")
    .select("id,organization_id,name,whatsapp_e164,message_template,use_case,utm,enabled")
    .eq("id", id.data)
    .eq("enabled", true)
    .maybeSingle();
  if (error || !data) return paginaDeSaida(null);
  const destino = await destinoDoLink(admin, data as LinkRastreavel, new URL(req.url).searchParams);
  const response = paginaDeSaida(destino);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
