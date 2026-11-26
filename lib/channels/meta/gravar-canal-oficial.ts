/**
 * Grava o canal oficial (API da Meta) de uma organização — o MESMO caminho para
 * as duas portas de entrada (#4074):
 *
 * - o token colado à mão em Conexões › API Oficial (`POST /api/v1/channels/official`);
 * - a janela da Meta (Embedded Signup), que devolve um código trocado pelo token
 *   da empresa (`POST /api/v1/channels/official/embedded-signup`).
 *
 * Uma função só para as duas portas porque o que vem depois do token é idêntico:
 * validar com a Graph API ANTES de gravar, cifrar, criar ou ressuscitar a linha,
 * registrar a origem e apontar o webhook do número para esta instalação. Duas
 * cópias são como as duas portas divergem.
 *
 * O texto dos comentários abaixo é o da rota original, que esta função recebeu.
 */
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import {
  ROTULOS_DA_ORIGEM,
  registrarOrigemDaConexao,
  type OrigemDaConexaoOficial,
} from "@/lib/channels/meta/origem-da-conexao";
import { validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import { registrarWebhookDaSessao } from "@/lib/channels/meta/webhook-da-sessao";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { traduzirLimiteDoPlano } from "@/lib/cobranca/limites";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { basePublicaDoWebhookMeta } from "@/lib/webhooks/url-publica";

export async function gravarCanalOficial(input: {
  req: NextRequest;
  requestId: string;
  orgId: string;
  userId: string;
  idioma: Idioma;
  phoneNumberId: string;
  wabaId: string;
  token: string;
  /** Constante de código de quem chama — nunca lida do corpo do request. */
  origem: OrigemDaConexaoOficial;
  /**
   * Chaves extras para o `metadata` do canal (ex.: a marca de coexistência).
   * Entram no canal novo E na reconexão — mescladas sobre o que já existe.
   */
  metadataExtra?: Record<string, unknown>;
}): Promise<NextResponse> {
  const { req, requestId, orgId, userId, phoneNumberId, wabaId, token, origem } = input;
  const t = (texto: string) => traduzir(texto, input.idioma);

  // VALIDA ANTES DE GRAVAR. `wabaId` junto: a checagem do número sozinha aceita o
  // par trocado (número de uma conta, id de outra), e o registro do webhook logo
  // abaixo apontaria o override de um número que esta instalação não controla.
  const validacao = await validateMetaCredentials({ phoneNumberId, token, wabaId });
  if (!validacao.ok) {
    return fail("invalid_request", validacao.motivo, 422, { requestId });
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) {
    // Sem a GUC de cifra configurada, gravar o token em claro seria pior que
    // recusar. O operador precisa saber que falta uma configuração de servidor.
    return fail(
      "invalid_request",
      t("cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado"),
      422,
      { requestId },
    );
  }

  // A busca NÃO filtra `archived_at`: um canal oficial excluído é exatamente o
  // que esta gravação precisa achar para trazer de volta. Ignorá-lo criaria uma
  // SEGUNDA linha oficial na org — e a linha velha continuaria segurando o par
  // (org, número) na trava da 0106.
  const buscarExistente = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .maybeSingle();
  const { data: existenteRaw } = await queryTolerantToMissingArchived(
    () => buscarExistente(`id, ${ARCHIVED_AT}, webhook_path_token, display_name, metadata`),
    () => buscarExistente("id, webhook_path_token, display_name, metadata"),
  );
  const existente = existenteRaw as {
    id: string;
    archived_at?: string | null;
    webhook_path_token?: string | null;
    display_name?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  const metadataExtra = input.metadataExtra ?? {};

  const linha = {
    organization_id: orgId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phoneNumberId,
    meta_waba_id: wabaId,
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}` : null,
    // O nome do provedor só batiza a conexão; depois dela o nome é do operador.
    display_name: existente?.display_name || (validacao.verifiedName ?? "Canal oficial"),
    status: "WORKING",
  };

  // `update` quando já existe em vez de upsert: a trava única de (org,
  // phone_number) é um índice único PARCIAL e não serve de árbitro de
  // `ON CONFLICT` pelo PostgREST. O update passa por `reactivateChannelSession`
  // porque reconectar é ressuscitar.
  let idDaSessao: string | null = existente?.id ?? null;
  let webhookPathToken: string | null = existente?.webhook_path_token ?? null;
  let error: { message?: string | null } | null = null;

  if (existente) {
    ({ error } = await reactivateChannelSession(
      admin,
      {
        organizationId: orgId,
        channelSessionId: existente.id,
        archivedAt: existente.archived_at ?? null,
      },
      // A reconexão mescla o `metadataExtra` sobre o que já existe: sem isso a
      // marca de coexistência só valeria para o canal novo, e o resto do
      // `metadata` (a configuração do pré-go-live) não pode ser apagado.
      Object.keys(metadataExtra).length > 0
        ? { ...linha, metadata: { ...(existente.metadata ?? {}), ...metadataExtra } }
        : linha,
      {
        userId,
        requestId,
        metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number },
      },
    ));
  } else {
    const inserida = await admin
      .from("channel_sessions")
      .insert({
        ...linha,
        webhook_secret_encrypted: cifrado,
        metadata: { ...metadataInicialDoCanal(), ...metadataExtra },
      })
      .select("id, webhook_path_token")
      .maybeSingle();
    error = inserida.error;
    idDaSessao = inserida.data?.id ?? null;
    webhookPathToken = inserida.data?.webhook_path_token ?? null;
  }

  if (error) {
    // Ressuscitar ou criar o canal acima do plano: o gatilho de canais recusa.
    const limite = traduzirLimiteDoPlano(error, input.idioma);
    if (limite) return fail(limite.code, limite.message, 409, { requestId, details: limite.details });
    return fail("internal_error", error.message ?? "channel_session_write_failed", 500, {
      requestId,
    });
  }

  // DE ONDE nasceu esta conexão (#4074). Depois da gravação e best-effort: a
  // coluna chega na migration 9328, e num banco anterior a ela o canal continua
  // conectado.
  const origemRegistrada =
    idDaSessao !== null
      ? await registrarOrigemDaConexao(admin, {
          organizationId: orgId,
          channelSessionId: idDaSessao,
          origem,
        })
      : null;

  // O webhook DESTE número, registrado pela própria instalação. DEPOIS de gravar:
  // o GET de verificação da Meta chega no instante do registro e procura a sessão
  // pelo `webhook_path_token`.
  const webhook =
    idDaSessao && webhookPathToken
      ? await registrarWebhookDaSessao({
          admin,
          channelSessionId: idDaSessao,
          phoneNumberId,
          wabaId,
          tokenCifrado: cifrado,
          webhookPathToken,
          base: basePublicaDoWebhookMeta(req),
          requestId,
        })
      : null;

  return ok({
    connected: true,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
    /** `false` não desfaz a conexão: banco anterior à 9328 não tem a coluna. */
    origemGravada: Boolean(origemRegistrada?.gravada),
    origem: { valor: origem, rotulo: ROTULOS_DA_ORIGEM[origem] },
    /** `registrado: false` NÃO desfaz a conexão — o canal envia; falta a entrega. */
    webhookRegistro: webhook
      ? { registrado: webhook.registrado, url: webhook.url, erro: webhook.erro, em: webhook.em }
      : null,
  });
}

/**
 * Mescla chaves no `metadata` do canal oficial da organização DEPOIS de gravado —
 * para o que só existe depois de a conexão ser aceita (o PIN do registro do
 * número). `false` quando não há canal ou a escrita foi recusada.
 */
export async function mesclarNoMetadataDoCanalOficial(
  orgId: string,
  extra: Record<string, unknown>,
): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("channel_sessions")
    .select("id, metadata")
    .eq("organization_id", orgId)
    .eq("provider", CHANNEL_PROVIDER_META)
    .maybeSingle();
  const canal = data as { id: string; metadata?: Record<string, unknown> | null } | null;
  if (!canal) return false;
  const { error } = await admin
    .from("channel_sessions")
    .update({ metadata: { ...(canal.metadata ?? {}), ...extra } })
    .eq("organization_id", orgId)
    .eq("id", canal.id);
  return !error;
}
