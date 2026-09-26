/**
 * GET /api/v1/plataformas-de-anuncio/google/connect — começa a conexão da
 * organização com o Google Ads.
 *
 * Manda o admin ao consentimento do Google com um `state` assinado que carrega
 * de qual ORGANIZAÇÃO é a conexão. Irmã de `app/api/v1/agenda/google/connect/route.ts`,
 * mais simples: a conexão é da organização, não da pessoa (a linha em
 * `ad_platform_connections` é `unique (organization_id, platform)`), então não
 * há vínculo de conta por cookie para provar — só o `state` já basta.
 *
 * Piso de papel: `admin`, mesmo piso de `updateAdPlatformConnection.ts` (a
 * conexão da Meta) — é a conta de anúncios do negócio, não uma preferência de
 * atendente individual.
 *
 * Todo desfecho volta pra tela de Configurações › Conversões com
 * `?erro=<código>`, nunca JSON — este endereço é aberto pelo navegador, num
 * clique de botão.
 */
import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { NextResponse, type NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { env } from "@/lib/env";
import { configuracaoDoGoogleAds } from "@/lib/plataformas-de-anuncio/google/config";
import { emitirEstado } from "@/lib/plataformas-de-anuncio/google/estado";
import { montarUrlDeConsentimento } from "@/lib/plataformas-de-anuncio/google/oauth";

export const dynamic = "force-dynamic";

function voltarComErro(codigo: string): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return NextResponse.redirect(new URL(`/app/settings/conversoes?erro=${codigo}`, base));
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = req.headers.get("x-request-id") ?? undefined;

  const autorizado = await requireRole("admin", { requestId, resource: "ad_platform_connections" });
  if (!autorizado.ok) return autorizado.response;
  const { user, org } = autorizado;

  const escolha = z
    .enum(["google_ads", "data_manager"])
    .safeParse(new URL(req.url).searchParams.get("api") ?? "data_manager");
  if (!escolha.success) return voltarComErro("estado_invalido");
  const api = escolha.data;
  const app = configuracaoDoGoogleAds(api);
  if (!app) {
    // Não audita: não houve tentativa de conectar nada, e a instalação sem
    // chave não é um evento da organização — mesma régua do irmão da Agenda.
    return voltarComErro("google_ads_nao_configurado");
  }

  let state: string;
  try {
    state = emitirEstado(
      { organizationId: org.orgId, userId: user.id, api },
      { segredo: env.INTERNAL_SECRET, agora: new Date() },
    );
  } catch {
    return voltarComErro("estado_invalido");
  }

  return NextResponse.redirect(montarUrlDeConsentimento(app, { state, api }));
}
