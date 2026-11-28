/**
 * A volta do consentimento da Microsoft.
 *
 * A identidade NÃO vem da sessão (cookie `strict` não viaja nesta navegação): vem
 * do `state` assinado, conferido com o cookie de vínculo e com nonce de uso único.
 * Nada é auditado nem gravado antes de o `state` conferir.
 */
import { NextResponse, type NextRequest } from "next/server";

import { origemLocalDosCabecalhos } from "@/lib/agenda/google/config";
import { verificarEstado } from "@/lib/agenda/google/estado";
import { NOME_DO_VINCULO, vinculoConfere } from "@/lib/agenda/google/vinculo";
import { CAMINHO_DO_CALLBACK_DA_MICROSOFT, configuracaoDaMicrosoft } from "@/lib/agenda/microsoft/config";
import { graphDaMicrosoft } from "@/lib/agenda/microsoft/graph";
import { desfechoDaRecusa, temPermissaoDeAgenda, trocarCodigo } from "@/lib/agenda/microsoft/oauth";
import { COLUNAS_DA_CONEXAO, sincronizarConexao, type ConexaoDaMicrosoft } from "@/lib/agenda/microsoft/sync";
import { PROVEDOR_MICROSOFT } from "@/lib/agenda/tipos";
import { comIdDaRequisicao } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { supportCallbackWriteAllowed } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

/**
 * Página ponte, e não redirect 302: a navegação seguinte precisa partir do
 * próprio site para o cookie de sessão `strict` acompanhar.
 */
function voltar(codigo: string, req: NextRequest): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const destino = new URL(`/app/agenda?outlook=${encodeURIComponent(codigo)}`, base).toString();
  const seguro = destino.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const resposta = comIdDaRequisicao(
    new NextResponse(
      `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">` +
        `<meta name="robots" content="noindex">` +
        `<noscript><meta http-equiv="refresh" content="0;url=${seguro}"></noscript>` +
        `<title>Voltando…</title></head><body><p>Voltando para a sua agenda…</p>` +
        `<script>location.replace(${JSON.stringify(destino)})</script>` +
        `<noscript><p><a href="${seguro}">Continuar</a></p></noscript></body></html>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    ),
    req,
  );
  resposta.cookies.set(NOME_DO_VINCULO, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK_DA_MICROSOFT,
    maxAge: 0,
  });
  return resposta;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const recusa = url.searchParams.get("error");
  if (recusa) return voltar(desfechoDaRecusa(recusa, url.searchParams.get("error_description")), req);

  let estado: ReturnType<typeof verificarEstado> = null;
  try {
    estado = verificarEstado(url.searchParams.get("state"), { segredo: env.INTERNAL_SECRET, agora: new Date() });
  } catch {
    return voltar("retorno_nao_verificavel", req);
  }
  if (!estado) {
    await audit({ action: "agenda.microsoft.conexao_falhou", metadata: { reason: "state_invalido" } });
    return voltar("retorno_nao_verificavel", req);
  }
  const { organizationId, userId } = estado;
  const falhar = async (codigo: string, reason: string) => {
    await audit({
      action: "agenda.microsoft.conexao_falhou",
      organizationId,
      metadata: { reason, user_id: userId },
    });
    return voltar(codigo, req);
  };

  if (!vinculoConfere(req.cookies.get(NOME_DO_VINCULO)?.value, estado.nonce, env.INTERNAL_SECRET))
    return falhar("retorno_nao_verificavel", "vinculo_ausente_ou_nao_confere");
  const code = url.searchParams.get("code");
  if (!code) return falhar("retorno_nao_verificavel", "sem_codigo");

  const app = await configuracaoDaMicrosoft(origemLocalDosCabecalhos(req.headers) ?? undefined);
  if (!app) return voltar("nao_configurado", req);

  if (!(await supportCallbackWriteAllowed(organizationId, userId, estado.authSessionId)))
    return voltar("retorno_nao_verificavel", req);

  const admin = createAdminClient();
  const { data: membro } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (!membro) return falhar("retorno_nao_verificavel", "vinculo_revogado");

  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: estado.nonce,
    organization_id: organizationId,
    user_id: userId,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce)
    return falhar(
      "retorno_nao_verificavel",
      erroDoNonce.code === "23505" ? "state_reutilizado" : "nonce_indisponivel",
    );

  const leitura = await trocarCodigo(app, code, { agora: new Date() });
  if (!leitura.ok)
    return falhar(
      leitura.motivo === "credencial" ? "credencial_recusada" : "troca_de_codigo_falhou",
      leitura.detalhe,
    );
  const { token } = leitura;
  if (!temPermissaoDeAgenda(token.escopos)) return falhar("permissao_incompleta", "scope_missing");
  if (!token.refreshToken) return falhar("troca_de_codigo_falhou", "sem_token_de_renovacao");

  let conta: string | null = null;
  try {
    conta = await graphDaMicrosoft(token.accessToken).conta();
  } catch {
    conta = null;
  }
  if (!conta) return falhar("conta_indisponivel", "conta_indisponivel");

  const access = await encryptWebhookSecret(admin, token.accessToken);
  const refresh = await encryptWebhookSecret(admin, token.refreshToken);
  if (!access || !refresh) return falhar("cifra_indisponivel", "cifra_indisponivel");

  const { data: gravada, error: erroAoGravar } = await admin
    .from("calendar_connections")
    .upsert(
      {
        organization_id: organizationId,
        user_id: userId,
        provider: PROVEDOR_MICROSOFT,
        account_email: conta,
        oauth_access_token_encrypted: access,
        oauth_refresh_token_encrypted: refresh,
        token_expires_at: token.expiraEm,
        scopes: token.escopos,
        status: "healthy",
        last_sync_error: null,
        catalog_retry_at: null,
      },
      { onConflict: "organization_id,user_id,provider,account_email" },
    )
    .select(COLUNAS_DA_CONEXAO)
    .single();
  if (erroAoGravar || !gravada) return falhar("nao_consegui_guardar", "upsert_falhou");

  await audit({
    actorUserId: userId,
    actorAuthSessionId: estado.authSessionId,
    action: "agenda.microsoft.conexao_concluida",
    organizationId,
    metadata: { user_id: userId, account_email: conta },
  });

  // Primeira leitura já aqui: a pessoa volta e vê o ocupado. Falha não desfaz a
  // conexão — o cron tenta de novo.
  await sincronizarConexao(admin, app, gravada as unknown as ConexaoDaMicrosoft, { forcar: true });

  return voltar("conectada", req);
}
