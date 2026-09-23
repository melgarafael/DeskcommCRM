/**
 * GET /api/v1/anuncios/google/[org] — a landing page de captura de gclid.
 *
 * Este é o endereço que vai no campo "URL final" do anúncio do Google Ads,
 * com `{gclid}` na ValueTrack (`...?gclid={gclid}`). É retorno de NAVEGADOR de
 * quem CLICOU NO ANÚNCIO — nunca JSON: por isso esta rota não usa `ok`/`fail`
 * de `lib/api/wrappers.ts` (aquele contrato é para o cliente do PRÓPRIO app, e
 * um erro `{error:{...}}` na tela de alguém que só queria falar no WhatsApp é
 * o pior desfecho possível para uma rota que existe para não perder o clique).
 *
 * ─── O que esta rota faz, em ordem ──────────────────────────────────────────
 *
 * 1. Rate limit por IP — é pública e sem autenticação, então é superfície de
 *    abuso (custo de linha nova em `google_ads_click_refs` a cada hit).
 * 2. Valida `gclid` — sem ele não há o que capturar; a pessoa ainda assim
 *    precisa conseguir falar no WhatsApp, então o fallback é o link SEM token,
 *    nunca uma tela de erro.
 * 3. Resolve a organização pelo `slug` e lê `google_ads_landing_pages`. Sem
 *    conexão configurada ou desligada, mesma régua: cai para uma página neutra
 *    em vez de expor "esta organização não existe" a tráfego pago de terceiro.
 * 4. Cria o par token↔gclid e redireciona para o `wa.me` com o token embutido
 *    no texto pré-preenchido.
 *
 * ─── Por que a FALHA nunca é uma tela de erro para quem clicou ─────────────
 *
 * Todo caminho de erro devolve uma página curta com um ÚNICO botão "Abrir
 * WhatsApp" — sem o token, se for o caso, mas NUNCA um 404/500 cru. Um clique
 * de anúncio pago é dinheiro gasto; perder a ATRIBUIÇÃO por uma configuração
 * faltando é aceitável nesta v1 (fica no `google_ads_click_refs` como "nunca
 * aconteceu"), perder o LEAD inteiro por uma tela quebrada não é.
 *
 * As peças de navegador (IP do cliente, link do `wa.me`, página de saída) são
 * as MESMAS da rota irmã de captura de UTM da Meta e moram em
 * `lib/plataformas-de-anuncio/pagina-de-captura.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { criarClickRef } from "@/lib/plataformas-de-anuncio/google/captura-de-clique";
import { lerConfigDaLanding } from "@/lib/plataformas-de-anuncio/landing-config";
import {
  clientIp,
  paginaDeSaida,
  textoSemRef,
  whatsAppUrl,
} from "@/lib/plataformas-de-anuncio/pagina-de-captura";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ org: string }>;
}

const querySchema = z.object({
  gclid: z.string().trim().min(1).max(512).optional(),
});

const TETO_POR_IP = 30;
const JANELA_SEGUNDOS = 60;

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { org } = await ctx.params;

  const ip = clientIp(req);
  if (ip !== null) {
    const limite = await checkRateLimit(`google-lp:${org}:${ip}`, TETO_POR_IP, JANELA_SEGUNDOS);
    if (!limite.allowed) {
      // 429 sem corpo de marketing: quem estoura este teto num clique de
      // anúncio real não existe — é abuso, não humano legítimo.
      return new NextResponse(null, { status: 429, headers: { "Retry-After": String(JANELA_SEGUNDOS) } });
    }
  }

  const query = querySchema.safeParse({
    gclid: new URL(req.url).searchParams.get("gclid") ?? undefined,
  });
  const gclid = query.success ? (query.data.gclid ?? null) : null;

  const admin = createAdminClient();

  const { data: organizacao, error: erroOrg } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", org)
    .maybeSingle();

  if (erroOrg) {
    logger.error("[anuncios.google.landing] leitura da organização falhou", {
      org,
      detalhe: erroOrg.message,
    });
  }
  const organizationId = (organizacao as { id: string } | null)?.id ?? null;
  if (!organizationId) return paginaDeSaida(null);

  const config = await lerConfigDaLanding(admin, "google_ads_landing_pages", organizationId);
  if (!config) return paginaDeSaida(null);

  // Sem gclid não há o que capturar, mas a pessoa ainda consegue abrir o
  // WhatsApp — só não leva o `[ref:...]` no texto. Fica registrado em log,
  // não em `google_ads_click_refs` (a tabela é só para clique com gclid: uma
  // linha sem gclid não teria o que reportar depois).
  if (!gclid) {
    logger.warn("[anuncios.google.landing] hit sem gclid", { org });
    return paginaDeSaida(whatsAppUrl(config.whatsappE164, textoSemRef(config.messageTemplate)));
  }

  const queryRaw = Object.fromEntries(new URL(req.url).searchParams.entries());
  const criado = await criarClickRef(admin, organizationId, gclid, queryRaw);
  if (!criado) {
    // Falha ao gravar o clique: mesma régua — a pessoa não paga o preço de um
    // erro nosso, só a atribuição é que se perde.
    return paginaDeSaida(whatsAppUrl(config.whatsappE164, textoSemRef(config.messageTemplate)));
  }

  const mensagem = config.messageTemplate.replaceAll("{token}", criado.token);
  return paginaDeSaida(whatsAppUrl(config.whatsappE164, mensagem));
}
