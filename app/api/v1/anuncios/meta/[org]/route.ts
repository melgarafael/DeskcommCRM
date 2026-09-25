/**
 * GET /api/v1/anuncios/meta/[org] — o endereço que captura as UTMs e manda a
 * pessoa para o WhatsApp com um ref curto no texto.
 *
 * Irmã da rota de captura de `gclid` do Google Ads
 * (`app/api/v1/anuncios/google/[org]/route.ts`), com o mesmo desenho e as
 * mesmas peças de navegador. O que muda é o DADO capturado: lá é um clique
 * pago identificado por `gclid`, aqui são as UTMs que a página (ou a macro de
 * URL do anúncio) trouxe na query.
 *
 * ─── Por que o ref precisa passar por aqui ──────────────────────────────────
 *
 * O link `wa.me` não fala com o CRM: ele abre o aplicativo no aparelho da
 * pessoa, e o servidor nunca vê aquele clique. A única coisa que chega depois
 * é o TEXTO da mensagem, e por isso a origem tem de viajar dentro dele. O
 * contrato `[dk1:<base64url>]` (`lib/leads/origem-do-site.ts`) faz isso sem
 * servidor, ao custo de ~200 caracteres visíveis na mensagem do lead e de um
 * script que quem monta a página precisa colar. Esta rota troca as duas coisas
 * por um endereço: ela guarda as UTMs do lado do servidor e põe no texto só
 * `[ref:XXXXXX]`.
 *
 * O `[dk1:]` CONTINUA valendo — nada nesta rota o depreca.
 *
 * ─── De onde as UTMs chegam nesta query ─────────────────────────────────────
 *
 * De quem aponta para cá, e são dois casos:
 *
 *   1. o anúncio aponta direto para este endereço, com as macros dinâmicas de
 *      campanha, conjunto, anúncio e posicionamento nos parâmetros de URL —
 *      é o caso do Google Ads com `{gclid}`, e o que não depende da página;
 *   2. a landing page aponta o botão de WhatsApp para cá REPASSANDO a própria
 *      query string. Um botão de href fixo não repassa nada: nesse caso a
 *      captura acontece sem UTM nenhuma, e a rota cai no caminho sem ref.
 *
 * ─── Por que a FALHA nunca é uma tela de erro ───────────────────────────────
 *
 * Mesma régua da rota do Google: todo caminho ruim devolve o WhatsApp — sem o
 * ref, se for o caso — e nunca um 404/500 cru. Perder a atribuição é
 * aceitável; perder o lead não.
 */
import { NextResponse, type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { normalizarUtm } from "@/lib/leads/origem-do-site";
import { criarClickRef } from "@/lib/plataformas-de-anuncio/captura-de-clique";
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

const TETO_POR_IP = 30;
const JANELA_SEGUNDOS = 60;

export async function GET(req: NextRequest, ctx: RouteContext): Promise<Response> {
  const { org } = await ctx.params;

  const ip = clientIp(req);
  if (ip !== null) {
    const limite = await checkRateLimit(`meta-lp:${org}:${ip}`, TETO_POR_IP, JANELA_SEGUNDOS);
    if (!limite.allowed) {
      // 429 sem corpo de marketing: quem estoura este teto num clique real não
      // existe — é abuso, não humano legítimo.
      return new NextResponse(null, { status: 429, headers: { "Retry-After": String(JANELA_SEGUNDOS) } });
    }
  }

  const parametros = new URL(req.url).searchParams;
  // A MESMA normalização do `[dk1:]`: lista fechada de chaves e teto por valor.
  // O que não for chave de campanha não atravessa — nome, telefone e e-mail
  // ficam de fora por construção, não por filtro de última hora.
  const utm = normalizarUtm(Object.fromEntries(parametros.entries()));

  const admin = createAdminClient();

  const { data: organizacao, error: erroOrg } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", org)
    .maybeSingle();

  if (erroOrg) {
    logger.error("[anuncios.meta.landing] leitura da organização falhou", {
      org,
      detalhe: erroOrg.message,
    });
  }
  const organizationId = (organizacao as { id: string } | null)?.id ?? null;
  if (!organizationId) return paginaDeSaida(null);

  const config = await lerConfigDaLanding(admin, "meta_ads_landing_pages", organizationId);
  if (!config) return paginaDeSaida(null);

  // Sem UTM nenhuma não há o que guardar, e um ref que não aponta para origem
  // alguma só suja a mensagem do lead. A pessoa vai para o WhatsApp do mesmo
  // jeito, sem ref.
  if (Object.keys(utm).length === 0) {
    logger.warn("[anuncios.meta.landing] hit sem UTM", { org });
    return paginaDeSaida(whatsAppUrl(config.whatsappE164, textoSemRef(config.messageTemplate)));
  }

  const queryRaw = Object.fromEntries(parametros.entries());
  const criado = await criarClickRef(admin, "meta_ads_click_refs", organizationId, {
    utm,
    query_raw: queryRaw,
  });
  if (!criado) {
    // Falha ao gravar: mesma régua — a pessoa não paga o preço de um erro
    // nosso, só a atribuição é que se perde.
    return paginaDeSaida(whatsAppUrl(config.whatsappE164, textoSemRef(config.messageTemplate)));
  }

  const mensagem = config.messageTemplate.replaceAll("{token}", criado.token);
  return paginaDeSaida(whatsAppUrl(config.whatsappE164, mensagem));
}
