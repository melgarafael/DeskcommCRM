/**
 * GET /api/v1/plataformas-de-anuncio/google/connect — começa a conexão da
 * organização com o Google Ads.
 *
 * Manda o admin ao consentimento do Google com um `state` assinado que carrega
 * de qual ORGANIZAÇÃO é a conexão. Irmã de `app/api/v1/agenda/google/connect/route.ts`,
 * mais simples: a conexão é da organização, não da pessoa (a linha em
 * `ad_platform_connections` é `unique (organization_id, platform)`). Grava o
 * mesmo cookie de vínculo da Agenda (`lib/agenda/google/vinculo.ts`), restrito
 * ao caminho do callback daqui: na volta, ele prova que o navegador que
 * retorna é o que saiu.
 *
 * Piso de papel: `admin`, mesmo piso de `updateAdPlatformConnection.ts` (a
 * conexão da Meta) — é a conta de anúncios do negócio, não uma preferência de
 * atendente individual.
 *
 * O painel de mídia usa purpose=reporting para conectar o anunciante escolhido.
 * O fluxo de conversões continua configurando uma conexão por organização.
 */
import { randomBytes } from "node:crypto";

import { z } from "zod";
import { authenticatedSessionId, requireSupportWrite } from "@/lib/impersonate/support";
import { NextResponse, type NextRequest } from "next/server";

import { assinarVinculo, NOME_DO_VINCULO, VALIDADE_DO_VINCULO_S } from "@/lib/agenda/google/vinculo";

import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { CAMINHO_DO_CALLBACK, configuracaoDoGoogleAds } from "@/lib/plataformas-de-anuncio/google/config";
import { emitirEstado } from "@/lib/plataformas-de-anuncio/google/estado";
import { contaDeRelatorio } from "@/lib/plataformas-de-anuncio/google/conta-de-relatorio";
import { montarUrlDeConsentimento } from "@/lib/plataformas-de-anuncio/google/oauth";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { comIdDaRequisicao } from "@/lib/api/wrappers";

export const dynamic = "force-dynamic";

function voltarComErro(codigo: string, req: NextRequest, relatorio = false): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const url = new URL(relatorio ? "/app/ads/google?aba=midia" : "/app/settings/conversoes", base);
  url.searchParams.set("erro", codigo);
  return comIdDaRequisicao(NextResponse.redirect(url), req);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = req.headers.get("x-request-id") ?? undefined;

  const params = new URL(req.url).searchParams;
  const finalidade = params.get("purpose");
  const relatorio = finalidade === "reporting";
  const autorizado = await requireRole("admin", {
    requestId,
    resource: relatorio ? "google_ads_reporting_accounts" : "ad_platform_connections",
    allowPlatformAdmin: relatorio,
  });
  if (!autorizado.ok) return autorizado.response;
  const { user, org } = autorizado;

  if (finalidade !== null && !relatorio) return voltarComErro("estado_invalido", req);
  const conta = relatorio ? contaDeRelatorio.safeParse({
    customerId: params.get("customer_id"), loginCustomerId: params.get("login_customer_id")?.trim() || null,
    label: params.get("label"),
    suporteId: user.support?.id,
  }) : null;
  if (conta && !conta.success) return voltarComErro("estado_invalido", req, true);
  const origem = req.headers.get("sec-fetch-site");
  if (relatorio && origem && origem !== "same-origin" && origem !== "none") {
    return voltarComErro("estado_invalido", req, true);
  }
  const escolha = z
    .enum(["google_ads", "data_manager"])
    .safeParse(relatorio ? "google_ads" : params.get("api") ?? "data_manager");
  if (!escolha.success) return voltarComErro("estado_invalido", req);
  const api = escolha.data;
  const app = configuracaoDoGoogleAds(relatorio ? "relatorio" : api);
  if (!app) {
    // Não audita: não houve tentativa de conectar nada, e a instalação sem
    // chave não é um evento da organização — mesma régua do irmão da Agenda.
    return voltarComErro("google_ads_nao_configurado", req, relatorio);
  }

  // O nonce nasce aqui porque é usado duas vezes: dentro do `state` e na
  // assinatura do cookie de vínculo — o par que o callback confere.
  const nonce = randomBytes(16).toString("base64url");

  let state: string;
  try {
    state = emitirEstado(
      { organizationId: org.orgId, userId: user.id, api, authSessionId: await authenticatedSessionId(), relatorio: conta?.data },
      { segredo: env.INTERNAL_SECRET, agora: new Date(), nonce },
    );
  } catch {
    return voltarComErro("estado_invalido", req, relatorio);
  }

  // Com developer token, a mesma autorização libera criar ações de conversão e
  // ler campanhas pela API do Google Ads (0436).
  const incluirGoogleAds = Boolean(env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim());
  const resposta = comIdDaRequisicao(NextResponse.redirect(montarUrlDeConsentimento(app, {
    state, api, incluirGoogleAds, selecionarConta: relatorio,
  })), requestId);
  // `lax` e `cookieSecure()` pelos mesmos motivos do connect da Agenda: strict
  // não viaja na volta do Google, e `secure: true` literal perderia o cookie em
  // instalação servida por http.
  resposta.cookies.set(NOME_DO_VINCULO, assinarVinculo(nonce, env.INTERNAL_SECRET), {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK,
    maxAge: VALIDADE_DO_VINCULO_S,
  });
  return resposta;
}
