/**
 * GET /api/v1/plataformas-de-anuncio/google/callback — a volta do
 * consentimento do Google Ads.
 *
 * Confere o `state`, troca o código por tokens, cifra e grava só o refresh
 * token. Irmã de `app/api/v1/agenda/google/callback/route.ts`, mais enxuta:
 * não há vínculo de conta por cookie (a conexão é da organização, provada
 * pelo `state`), não há escopo opcional para conferir (um só, obrigatório) e
 * não há descoberta de conta primária — a conta e a ação de conversão são
 * digitadas à mão na tela, depois deste passo.
 *
 * É retorno de NAVEGADOR: todo desfecho volta para
 * `/app/settings/conversoes` com `?erro=<código>` ou `?ok=1`, nunca JSON.
 *
 * ─── A ORDEM DOS PASSOS É CONTRATO — mesma disciplina do irmão ────────────
 * 1. `error` na query ANTES de tudo: "Cancelar" não é falha.
 * 2. `state` ANTES do `code`: sem organização não há o que auditar.
 * 3. troca do código DEPOIS da verificação do `state`: nunca gasta o `code`
 *    (uso único) antes de saber que o retorno é legítimo.
 * 4. cifra ANTES do upsert: gravar o refresh token em claro por um instante
 *    é gravá-lo em claro.
 */
import { NextResponse, type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { configuracaoDoGoogleAds } from "@/lib/plataformas-de-anuncio/google/config";
import { verificarEstado } from "@/lib/plataformas-de-anuncio/google/estado";
import { trocarCodigoPorToken } from "@/lib/plataformas-de-anuncio/google/token";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

function voltar(base: string, params: Record<string, string>): NextResponse {
  const url = new URL("/app/settings/conversoes", base || "http://localhost:3000");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const base = env.NEXT_PUBLIC_APP_URL;
  const url = new URL(req.url);

  // 1. Cancelamento não é erro.
  if (url.searchParams.get("error")) {
    return voltar(base, { erro: "cancelado" });
  }

  // 2. `state` antes do `code`.
  const estado = verificarEstado(url.searchParams.get("state"), {
    segredo: env.INTERNAL_SECRET,
    agora: new Date(),
  });
  if (!estado) return voltar(base, { erro: "estado_invalido" });

  const code = url.searchParams.get("code");
  if (!code) return voltar(base, { erro: "sem_codigo" });

  const app = configuracaoDoGoogleAds();
  if (!app) return voltar(base, { erro: "google_ads_nao_configurado" });

  // 3. Troca — só depois do state confirmado.
  const leitura = await trocarCodigoPorToken(app, code, { agora: new Date() });
  if (!leitura.ok) {
    logger.error("[plataformas-de-anuncio.google.callback] troca de código falhou", {
      organizationId: estado.organizationId,
      motivo: leitura.motivo,
      detalhe: leitura.detalhe.slice(0, 300),
    });
    return voltar(base, { erro: "troca_falhou" });
  }
  if (!leitura.token.refresh_token) {
    // Reconexão sem `prompt=consent` ter funcionado (extremamente raro, já que
    // sempre pedimos): sem refresh token não há o que gravar — a conexão
    // funcionaria por uma hora e morreria calada.
    return voltar(base, { erro: "sem_refresh_token" });
  }

  const admin = createAdminClient();

  // 4. Cifra antes do upsert.
  const cifrado = await encryptWebhookSecret(admin, leitura.token.refresh_token);
  if (!cifrado) return voltar(base, { erro: "cifra_indisponivel" });

  const { error } = await admin.from("ad_platform_connections").upsert(
    {
      organization_id: estado.organizationId,
      platform: "google_ads",
      google_refresh_token_encrypted: cifrado,
      updated_by: estado.userId,
    },
    { onConflict: "organization_id,platform" },
  );
  if (error) {
    logger.error("[plataformas-de-anuncio.google.callback] upsert falhou", {
      organizationId: estado.organizationId,
      detalhe: error.message,
    });
    return voltar(base, { erro: "erro_ao_gravar" });
  }

  await audit({
    action: "ad_platform_connection.updated",
    actorUserId: estado.userId,
    organizationId: estado.organizationId,
    resourceType: "ad_platform_connections",
    resourceId: null,
    metadata: { platform: "google_ads" },
  });

  return voltar(base, { ok: "1" });
}
