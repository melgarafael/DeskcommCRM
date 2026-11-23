/**
 * GET /api/v1/plataformas-de-anuncio/google/callback — a volta do
 * consentimento do Google Ads.
 *
 * Confere o `state`, troca o código por tokens, cifra e grava só o refresh
 * token. Para os relatórios, lê o anunciante com a nova autorização antes de
 * guardar o token para a organização e conta que iniciaram a conexão.
 *
 * É retorno de NAVEGADOR: todo desfecho volta para
 * a tela de conversões ou para a aba de mídia que iniciou a conexão.
 *
 * ─── A ORDEM DOS PASSOS É CONTRATO — mesma disciplina do irmão ────────────
 * 1. Cancelamento volta à tela de origem sem consumir o código ou nonce.
 * 2. `state` ANTES do `code`: sem organização não há o que auditar.
 *    Depois dele, o cookie de vínculo (o navegador que volta é o que saiu) e,
 *    só então, a régua de suporte e a queima do nonce.
 * 3. troca do código DEPOIS da verificação do `state`: nunca gasta o `code`
 *    (uso único) antes de saber que o retorno é legítimo.
 * 4. cifra ANTES do upsert: gravar o refresh token em claro por um instante
 *    é gravá-lo em claro.
 */
import { NextResponse, type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { NOME_DO_VINCULO, vinculoConfere } from "@/lib/agenda/google/vinculo";
import { supportCallbackWriteAllowed } from "@/lib/impersonate/support";
import { CAMINHO_DO_CALLBACK, configuracaoDoGoogleAds } from "@/lib/plataformas-de-anuncio/google/config";
import { verificarEstado } from "@/lib/plataformas-de-anuncio/google/estado";
import { conferirContaDeRelatorio } from "@/lib/plataformas-de-anuncio/google/api-google-ads";
import { trocarCodigoPorToken } from "@/lib/plataformas-de-anuncio/google/token";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { comIdDaRequisicao } from "@/lib/api/wrappers";
import { respostaDePonte } from "@/lib/auth/ponte-de-volta";
import { marcaDaSaida } from "@/lib/branding/saida";

export const dynamic = "force-dynamic";

/**
 * A volta para a tela de conversões (ou para a aba de mídia, no fluxo de
 * relatórios) — por PONTE, não por 302 (issue #4335).
 *
 * Esta rota é o retorno de um consentimento do Google: a cadeia de navegação
 * começou em `accounts.google.com` e o cookie de sessão do produto é
 * `sameSite: "strict"`, que o navegador NÃO manda num initiator cross-site. Um
 * 302 daqui não rompe a cadeia: o salto seguinte continua cross-site, o
 * `proxy.ts` não enxerga usuário e manda a pessoa para `/login?next=…` — com a
 * conexão já gravada e sem nunca ver a tela de conversões. É a mesma classe da
 * #1646 (a volta da entrada com Google) e do irmão `agenda/google/callback`.
 *
 * A ponte devolve um documento same-origin com 200; o `location.replace` de
 * dentro dele é disparado por um documento NOSSO, e o cookie Strict viaja. O
 * `Set-Cookie` de limpeza do vínculo funciona igual num 200.
 */
async function voltar(base: string, params: Record<string, string>, req: NextRequest, relatorio = false): Promise<NextResponse> {
  const url = new URL(relatorio ? "/app/ads/google?aba=midia" : "/app/settings/conversoes", base || "http://localhost:3000");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const marca = await marcaDaSaida(null);
  const ponte = respostaDePonte(
    `${url.pathname}${url.search}`,
    marca.nome,
    relatorio ? "Voltando para a sua mídia…" : "Voltando para as suas conversões…",
  );
  const resposta = comIdDaRequisicao(
    new NextResponse(ponte.body, { status: ponte.status, headers: ponte.headers }),
    req,
  );
  // Toda saída passa por aqui: o vínculo morre com o fluxo, sucesso ou erro.
  resposta.cookies.set(NOME_DO_VINCULO, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK,
    maxAge: 0,
  });
  return resposta;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const base = env.NEXT_PUBLIC_APP_URL;
  const url = new URL(req.url);

  // O cancelamento sem state pertence ao fluxo original. Com state válido, ele
  // volta para a tela que iniciou o consentimento, sem gastar código ou nonce.
  const cancelado = !!url.searchParams.get("error");
  if (cancelado && !url.searchParams.get("state")) {
    return await voltar(base, { erro: "cancelado" }, req);
  }

  // 2. `state` antes do `code`. Sob `try`: a rota é pública e
  // `verificarEstado` lança com `INTERNAL_SECRET` curto — sem isto, 500.
  let estado: ReturnType<typeof verificarEstado>;
  try {
    estado = verificarEstado(url.searchParams.get("state"), {
      segredo: env.INTERNAL_SECRET,
      agora: new Date(),
    });
  } catch (erro) {
    logger.error("[plataformas-de-anuncio.google.callback] state não verificável", {
      motivo: erro instanceof Error ? erro.message : String(erro),
    });
    return await voltar(base, { erro: "estado_invalido" }, req);
  }
  const conta = estado?.relatorio;
  const responder = (params: Record<string, string>) => voltar(base, params, req, !!conta);
  if (cancelado) return await responder({ erro: "cancelado" });
  if (!estado) return await responder({ erro: "estado_invalido" });

  // O navegador que volta é o que saiu. Antes da queima do nonce: queimar
  // primeiro daria a quem tem um `state` vazado como derrubar a volta legítima.
  if (!vinculoConfere(req.cookies.get(NOME_DO_VINCULO)?.value, estado.nonce, env.INTERNAL_SECRET)) {
    logger.warn("[plataformas-de-anuncio.google.callback] vínculo do navegador não confere", {
      organizationId: estado.organizationId,
    });
    return await responder({ erro: "estado_invalido" });
  }

  const code = url.searchParams.get("code");
  if (!code) return await responder({ erro: "sem_codigo" });

  const app = configuracaoDoGoogleAds(conta ? "relatorio" : estado.api);
  if (!app) return await responder({ erro: "google_ads_nao_configurado" });

  if (!(await supportCallbackWriteAllowed(estado.organizationId, estado.userId, estado.authSessionId))) {
    return await responder({ erro: "estado_invalido" });
  }

  const admin = createAdminClient();

  // O retorno vale UMA vez: o nonce do `state` é queimado ANTES da troca, na
  // mesma tabela e pela mesma razão do callback do Google Agenda
  // (`app/api/v1/agenda/google/callback/route.ts`). Antes da troca porque o
  // `code` do Google é de uso único: queimar depois o gastaria antes de saber
  // que o `state` era repetido. Qualquer erro recusa, não só o `23505`: sem
  // gravar não há uso único a garantir.
  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: estado.nonce,
    organization_id: estado.organizationId,
    user_id: estado.userId,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce) return await responder({ erro: "estado_invalido" });

  // 3. Troca — só depois do state confirmado e queimado.
  const leitura = await trocarCodigoPorToken(app, code, { agora: new Date() });
  if (!leitura.ok) {
    logger.error("[plataformas-de-anuncio.google.callback] troca de código falhou", {
      organizationId: estado.organizationId,
      motivo: leitura.motivo,
      detalhe: leitura.detalhe.slice(0, 300),
    });
    return await responder({ erro: "troca_falhou" });
  }
  if (!leitura.token.refresh_token) {
    // Reconexão sem `prompt=consent` ter funcionado (extremamente raro, já que
    // sempre pedimos): sem refresh token não há o que gravar — a conexão
    // funcionaria por uma hora e morreria calada.
    return await responder({ erro: "sem_refresh_token" });
  }

  if (conta) {
    const acesso = await conferirContaDeRelatorio(leitura.token.access_token, conta.customerId, conta.loginCustomerId);
    if (!acesso.ok) {
      if (acesso.falha === "projeto_sem_acesso") return await responder({ erro: acesso.falha });
      const semPermissao = acesso.falha === "sem_permissao" || acesso.falha === "reconectar";
      return await responder({ erro: semPermissao ? "sem_permissao" : "conta_indisponivel" });
    }
  }

  // 4. Cifra antes do upsert.
  const cifrado = await encryptWebhookSecret(admin, leitura.token.refresh_token);
  if (!cifrado) return await responder({ erro: "cifra_indisponivel" });

  if (conta) {
    const adminAtual = await admin.rpc("fn_google_ads_admin_do_relatorio", {
      p_org: estado.organizationId, p_actor: estado.userId,
      p_session: estado.authSessionId, p_suporte: conta.suporteId ?? null,
    });
    if (adminAtual.error || adminAtual.data !== true) return await responder({ erro: "estado_invalido" });
    const { error } = await admin.from("google_ads_reporting_accounts").upsert({
      organization_id: estado.organizationId,
      customer_id: conta.customerId,
      login_customer_id: conta.loginCustomerId,
      label: conta.label,
      refresh_token_encrypted: cifrado,
    }, { onConflict: "organization_id,customer_id" });
    if (error) return await responder({ erro: "erro_ao_gravar" });
    await audit({
      action: "ad_platform_connection.updated",
      actorUserId: estado.userId,
      actorAuthSessionId: estado.authSessionId,
      organizationId: estado.organizationId,
      resourceType: "google_ads_reporting_accounts",
      metadata: { platform: "google_ads", customer_id: conta.customerId, connection_purpose: "reporting" },
    });
    return await responder({ ok: "1", conta: conta.customerId });
  }

  const { error } = await admin.from("ad_platform_connections").upsert(
    {
      organization_id: estado.organizationId,
      platform: "google_ads",
      google_refresh_token_encrypted: cifrado,
      google_api: estado.api,
      updated_by: estado.userId,
    },
    { onConflict: "organization_id,platform" },
  );
  if (error) {
    logger.error("[plataformas-de-anuncio.google.callback] upsert falhou", {
      organizationId: estado.organizationId,
      detalhe: error.message,
    });
    return await voltar(base, { erro: "erro_ao_gravar" }, req);
  }

  await audit({
    action: "ad_platform_connection.updated",
    actorUserId: estado.userId,
    organizationId: estado.organizationId,
    resourceType: "ad_platform_connections",
    resourceId: null,
    metadata: { platform: "google_ads" },
  });

  return await voltar(base, { ok: "1" }, req);
}
