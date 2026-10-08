import type { SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { encryptWebhookSecret, decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { lerLimiteEstourado } from "@/lib/cobranca/limites";
import { fecharAvisoDePausaDoCanalArquivado } from "@/lib/channels/central-de-pausa";
import { resolverSaudeDaConexaoRemovida } from "@/lib/channels/health";
import { logger } from "@/lib/logger";
import { inboxSupported, SOCIAL_PROVIDER } from "./catalog";
import { listSocialAccounts, socialRequest, SocialError } from "./client";

export async function readSocialIntegration(db: SupabaseClient, org: string) {
  const { data, error } = await db
    .from("channel_integrations")
    .select("profile_id, credential_encrypted")
    .eq("organization_id", org)
    .maybeSingle();
  if (error) throw new SocialError("Não foi possível ler a integração.", 500);
  if (!data) return null;
  const key = await decryptWebhookSecret(db, data.credential_encrypted as string);
  if (!key)
    throw new SocialError(
      "A credencial não pôde ser aberta. Configure a integração novamente.",
      422,
    );
  return { profileId: data.profile_id as string, key };
}
/**
 * Salva a chave do perfil e ressincroniza a cópia por canal (spec 22, D1).
 *
 * O update abaixo NÃO filtra arquivamento de propósito: ele alcança ativas E
 * arquivadas, porque a arquivada pode voltar e uma cópia velha nela é a
 * divergência que prende a faixa. Travado por `sincronia.test.ts`.
 */
export async function configureSocialIntegration(
  db: SupabaseClient,
  org: string,
  key: string,
  profileId: string,
) {
  const profiles = z
    .object({ profiles: z.array(z.object({ _id: z.string() })) })
    .parse(await socialRequest(key, "profiles"));
  if (!profiles.profiles.some((p) => p._id === profileId))
    throw new SocialError("Perfil não encontrado para esta chave.", 422);
  const { data: existing, error: readError } = await db
    .from("channel_integrations")
    .select("profile_id")
    .eq("organization_id", org)
    .maybeSingle();
  if (readError) throw new SocialError("Não foi possível ler a configuração atual.", 500);
  if (existing && existing.profile_id !== profileId)
    throw new SocialError(
      "Este CRM já está vinculado a outro perfil. Preserve as conexões existentes.",
      409,
    );
  const encrypted = await encryptWebhookSecret(db, key);
  if (!encrypted) throw new SocialError("Cifra indisponível; a chave não foi gravada.", 422);
  const { error } = await db.from("channel_integrations").upsert({
    organization_id: org,
    profile_id: profileId,
    credential_encrypted: encrypted,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new SocialError("Não foi possível salvar a integração.", 500);
  const { error: channelError } = await db
    .from("channel_sessions")
    .update({ zernio_token_encrypted: encrypted })
    .eq("organization_id", org)
    .eq("provider", SOCIAL_PROVIDER);
  if (channelError)
    throw new SocialError(
      "Credencial salva; não foi possível atualizar os canais. Salve novamente.",
      500,
    );
}
/**
 * Desvincula o perfil social da organização (spec 22, D2).
 *
 * Apaga `channel_integrations` e NADA mais: se existir canal social ativo
 * (não arquivado), recusa com 409 e nomeia a saída — arquivar ou excluir os
 * canais antes. Nunca arquiva sozinho. Os avisos de saúde das sessões sociais
 * são fechados em best-effort, no mesmo contrato de `channel-sessions/[id]`.
 */
export async function desvincularPerfilSocial(db: SupabaseClient, org: string) {
  const ativos = await socialChannels(db, org);
  if (ativos.length > 0)
    throw new SocialError(
      "Há canais sociais ativos. Arquive ou exclua os canais antes de desvincular o perfil.",
      409,
    );
  const { data: removida, error: deleteError } = await db
    .from("channel_integrations")
    .delete()
    .eq("organization_id", org)
    .select("organization_id")
    .maybeSingle();
  if (deleteError) throw new SocialError("Não foi possível desvincular o perfil.", 500);
  if (!removida) throw new SocialError("Nenhum perfil vinculado para desvincular.", 404);
  let avisosFechados: "resolvido" | "sem_mudanca" | "falhou" = "sem_mudanca";
  try {
    const { data: sessoes, error: sessoesError } = await db
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", org)
      .eq("provider", SOCIAL_PROVIDER);
    if (sessoesError) throw sessoesError;
    let fechou = false;
    for (const sessao of (sessoes ?? []) as { id: string }[]) {
      const estado = await resolverSaudeDaConexaoRemovida(db, {
        id: sessao.id,
        organization_id: org,
        status: "STOPPED",
      });
      if (estado === "resolvido") fechou = true;
    }
    if (fechou) avisosFechados = "resolvido";
  } catch (err) {
    avisosFechados = "falhou";
    logger.warn("Falha ao fechar os avisos das conexões sociais desvinculadas", {
      organization_id: org,
      erro: err instanceof Error ? err.message : String(err),
    });
  }
  return { desvinculado: true as const, avisos_fechados: avisosFechados };
}
export async function socialChannels(db: SupabaseClient, org: string) {
  const { data, error } = await db
    .from("channel_sessions")
    .select("id, zernio_account_id, display_name, status, metadata, updated_at")
    .eq("organization_id", org)
    .eq("provider", SOCIAL_PROVIDER)
    .is("archived_at", null);
  if (error) throw new SocialError("Não foi possível ler os canais sociais.", 500);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    updated_at: row.updated_at as string,
    accountId: row.zernio_account_id as string,
    display_name: row.display_name as string | null,
    status: row.status as string,
    metadata: row.metadata as Record<string, unknown>,
  }));
}
export async function connectSocialInbox(
  db: SupabaseClient,
  org: string,
  accountId: string,
  publicBase: string,
) {
  const integration = await readSocialIntegration(db, org);
  if (!integration) throw new SocialError("Configure a integração primeiro.", 422);
  const accounts = await listSocialAccounts(integration.key, integration.profileId);
  const account = accounts.find((a) => a._id === accountId);
  if (!account || !account.isActive)
    throw new SocialError("Conta ausente ou desconectada neste perfil.", 422);
  if (!inboxSupported(account.platform))
    throw new SocialError("O atendimento desta rede ainda não está disponível no CRM.", 422);
  const existing = (await socialChannels(db, org)).find((c) => c.accountId === accountId);
  if (existing?.metadata.social_webhook_id && existing.status === "WORKING")
    return { channel_id: existing.id, already_connected: true };
  let token = randomBytes(24).toString("hex");
  let secret = randomBytes(32).toString("hex");
  if (existing) {
    // A compare-and-swap lease prevents concurrent retries from creating two subscriptions.
    if (existing.status === "STARTING" && Date.now() - Date.parse(existing.updated_at) < 90_000)
      throw new SocialError(
        "A conexão ainda está sendo configurada. Aguarde e atualize a lista.",
        409,
      );
    const { data: lease, error: leaseError } = await db
      .from("channel_sessions")
      .update({ status: "STARTING", updated_at: new Date().toISOString() })
      .eq("organization_id", org)
      .eq("id", existing.id)
      .eq("updated_at", existing.updated_at)
      .select("id")
      .maybeSingle();
    if (leaseError || !lease)
      throw new SocialError(
        "Outra configuração está em andamento. Aguarde e atualize a lista.",
        409,
      );
    const { data, error } = await db
      .from("channel_sessions")
      .select("webhook_path_token, webhook_secret_encrypted")
      .eq("organization_id", org)
      .eq("id", existing.id)
      .single();
    if (error || !data)
      throw new SocialError("Não foi possível recuperar a conexão pendente.", 500);
    const savedSecret = await decryptWebhookSecret(db, data.webhook_secret_encrypted as string);
    if (!savedSecret || !data.webhook_path_token)
      throw new SocialError("Não foi possível recuperar a assinatura da conexão.", 422);
    token = data.webhook_path_token as string;
    secret = savedSecret;
  }
  const keyEnc = await encryptWebhookSecret(db, integration.key);
  const secretEnc = await encryptWebhookSecret(db, secret);
  if (!keyEnc || !secretEnc) throw new SocialError("Cifra indisponível.", 422);
  const metadata = {
    ...(existing?.metadata ?? metadataInicialDoCanal()),
    social_platform: account.platform,
  };
  let channelId = existing?.id;
  if (!channelId) {
    const { data, error } = await db
      .from("channel_sessions")
      .insert({
        organization_id: org,
        provider: SOCIAL_PROVIDER,
        zernio_account_id: accountId,
        zernio_token_encrypted: keyEnc,
        webhook_secret_encrypted: secretEnc,
        webhook_path_token: token,
        display_name: `${account.platform} · ${account.username ?? account.displayName ?? accountId}`,
        status: "STARTING",
        metadata,
      })
      .select("id")
      .single();
    // Limite de números do plano (spec cobrança §5): sobe CRU para a rota dizer o número.
    if (lerLimiteEstourado(error)) throw error;
    if (error || !data)
      throw new SocialError(
        "Não foi possível criar o canal. Atualize a lista antes de tentar novamente.",
        409,
      );
    channelId = data.id as string;
  }
  const webhookUrl = `${publicBase}/api/v1/webhooks/channel/${token}`;
  try {
    // Reconcile after a timeout: creating a second subscription duplicates every event.
    const list = z
      .object({
        webhooks: z.array(z.object({ _id: z.string(), url: z.string(), isActive: z.boolean() })),
      })
      .parse(await socialRequest(integration.key, "webhooks/settings"));
    const found = list.webhooks.find((w) => w.url === webhookUrl);
    if (found && !found.isActive)
      throw new SocialError(
        "O webhook foi desativado pelo provedor. Reative-o após corrigir a falha.",
        409,
      );
    const webhookId =
      found?._id ??
      z.object({ webhook: z.object({ _id: z.string() }) }).parse(
        await socialRequest(integration.key, "webhooks/settings", {
          name: `CRM ${account.platform} ${accountId.slice(-8)}`,
          url: webhookUrl,
          secret,
          events: [
            "message.received",
            "message.sent",
            "message.delivered",
            "message.read",
            "message.failed",
          ],
          isActive: true,
        }),
      ).webhook._id;
    const { error: updateError } = await db
      .from("channel_sessions")
      .update({ status: "WORKING", metadata: { ...metadata, social_webhook_id: webhookId } })
      .eq("organization_id", org)
      .eq("id", channelId);
    if (updateError)
      throw new SocialError("Webhook criado; não foi possível confirmar o estado no CRM.", 500);
    return { channel_id: channelId, already_connected: !!existing };
  } catch (error) {
    await db
      .from("channel_sessions")
      .update({ status: "FAILED" })
      .eq("organization_id", org)
      .eq("id", channelId);
    throw error;
  }
}
/** 404 on a provider DELETE means a previous attempt already removed it; retries must converge. */
async function deleteAtProvider(key: string, path: string) {
  try {
    await socialRequest(key, path, undefined, "DELETE");
  } catch (error) {
    if (!(error instanceof SocialError && error.upstreamStatus === 404)) throw error;
  }
}
/**
 * Apaga no provedor a assinatura cujo id o CRM nunca chegou a gravar (issue #2364).
 *
 * ─── Como a assinatura fica órfã ────────────────────────────────────────────
 *
 * `connectSocialInbox` só escreve `metadata.social_webhook_id` DEPOIS de criar
 * a assinatura no Zernio. Se a gravação falhar (ou a conexão morrer no meio),
 * o canal vira `FAILED` com a assinatura viva lá fora e nenhuma referência a
 * ela aqui. Daí `disconnectSocialAccount` não apagava nada: arquivava a linha,
 * rotacionava o token, e a assinatura seguia mandando evento para uma URL que
 * agora resolve 404 — para sempre, sem erro do nosso lado.
 *
 * ─── Por que a reconciliação é pela URL ─────────────────────────────────────
 *
 * É o mesmo casamento que `connectSocialInbox` já faz contra duplicação: a
 * assinatura certa é a que aponta para o `webhook_path_token` DESTA linha — o
 * token que ainda está válido, porque o arquivamento só o rotaciona depois
 * (daí esta função rodar ANTES do patch). Casa-se pelo SUFIXO do caminho e não
 * pela origem completa: a instância pode ter mudado de domínio desde a conexão
 * e a assinatura continua apontando para o token certo.
 *
 * Só roda quando o id NÃO existe — quem já tem `social_webhook_id` continua
 * pelo caminho normal de baixo, que não muda.
 *
 * `webhooks/settings` fora do ar ou num formato que não dá para ler LANÇA, como
 * o resto das chamadas de provedor desta função: a linha fica intacta e a
 * desconexão pode ser tentada de novo. Silenciar aqui seria trocar a assinatura
 * viva por uma assinatura viva sem ninguém saber.
 */
async function apagarAssinaturaSemId(
  db: SupabaseClient,
  org: string,
  channelId: string,
  key: string,
) {
  const { data, error } = await db
    .from("channel_sessions")
    .select("webhook_path_token")
    .eq("organization_id", org)
    .eq("id", channelId)
    .maybeSingle();
  if (error)
    throw new SocialError("Não foi possível ler o canal para reconciliar o webhook.", 500);
  const token = data?.webhook_path_token;
  if (typeof token !== "string" || token.length === 0) return;
  const caminho = `/api/v1/webhooks/channel/${token}`;
  const lista = z
    .object({ webhooks: z.array(z.object({ _id: z.string(), url: z.string() })) })
    .parse(await socialRequest(key, "webhooks/settings"));
  const achada = lista.webhooks.find((w) => w.url.endsWith(caminho));
  if (!achada) return;
  await deleteAtProvider(key, `webhooks/settings?webhookId=${encodeURIComponent(achada._id)}`);
}
/**
 * A regra ÚNICA de "qual assinatura apagar", usada pelo desconectar e pelo DELETE
 * da Central de Conexões (#2424): id gravado e não vazio → apaga pelo id; senão →
 * reconcilia pela URL. Eram duas cópias e já divergiam: uma aceitava `""` e
 * mandava `DELETE webhooks/settings?webhookId=` vazio, sem achar a assinatura.
 * Tem de rodar ANTES do patch que rotaciona o token, ou a URL não casa mais.
 */
async function apagarAssinaturaDoCanal(
  db: SupabaseClient,
  org: string,
  channelId: string,
  key: string,
  webhookId: unknown,
) {
  if (typeof webhookId === "string" && webhookId.length > 0)
    await deleteAtProvider(key, `webhooks/settings?webhookId=${encodeURIComponent(webhookId)}`);
  else await apagarAssinaturaSemId(db, org, channelId, key);
}
/**
 * Apaga no provedor a assinatura de webhook de UM canal social (issue #2419).
 *
 * Cobre os dois estados da referência: com `metadata.social_webhook_id` apaga
 * pelo id; sem ele reconcilia pela URL do token ainda válido — a mesma
 * `apagarAssinaturaSemId` do #2364. Devolve `"sem_integracao"` quando a chave do
 * perfil já saiu do banco (perfil desvinculado): sem chave não há como falar com
 * o provedor, e o chamador registra e segue em best-effort, no mesmo contrato do
 * ramo da Meta em `channel-sessions/[id]`.
 *
 * Erro de provedor LANÇA — o chamador decide entre falhar fechado (como
 * `disconnectSocialAccount`) ou seguir em best-effort (como o DELETE da Central
 * de Conexões). 404 no DELETE é "já saiu" e converge, via `deleteAtProvider`.
 */
export async function apagarAssinaturaSocial(
  db: SupabaseClient,
  org: string,
  channelId: string,
): Promise<"apagada" | "sem_integracao"> {
  const integration = await readSocialIntegration(db, org);
  if (!integration) return "sem_integracao";
  const { data: channel, error } = await db
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", org)
    .eq("id", channelId)
    .maybeSingle();
  if (error)
    throw new SocialError("Não foi possível ler o canal para apagar o webhook.", 500);
  await apagarAssinaturaDoCanal(
    db,
    org,
    channelId,
    integration.key,
    channel?.metadata?.social_webhook_id,
  );
  return "apagada";
}
/**
 * Stops the inbox for one account and, with `removeAccount`, disconnects it from the provider.
 * Provider calls run first: if one fails the channel stays intact and the action can be retried.
 * Conversations are kept; the channel is archived, never deleted (issue #1314).
 */
export async function disconnectSocialAccount(
  db: SupabaseClient,
  org: string,
  accountId: string,
  removeAccount: boolean,
) {
  const integration = await readSocialIntegration(db, org);
  if (!integration) throw new SocialError("Configure a integração primeiro.", 422);
  const listed = (await listSocialAccounts(integration.key, integration.profileId)).some(
    (a) => a._id === accountId,
  );
  const channel = (await socialChannels(db, org)).find((c) => c.accountId === accountId);
  if (!listed && !channel) throw new SocialError("Conta não encontrada neste perfil.", 404);
  // Antes do patch de arquivamento: sem id gravado, a assinatura só é achada pela
  // URL do token que esta linha ainda tem (issue #2364).
  if (channel)
    await apagarAssinaturaDoCanal(
      db,
      org,
      channel.id,
      integration.key,
      channel.metadata.social_webhook_id,
    );
  // Only accounts listed under this profile: the key may reach other profiles' accounts.
  if (removeAccount && listed)
    await deleteAtProvider(integration.key, `accounts/${encodeURIComponent(accountId)}`);
  if (!channel)
    return {
      channel_id: null,
      account_removed: removeAccount && listed,
      avisos_fechados: "sem_mudanca" as const,
    };
  const now = new Date().toISOString();
  const { error } = await db
    .from("channel_sessions")
    .update({
      archived_at: now,
      status: "STOPPED",
      last_status_change_at: now,
      // A late delivery to the old URL must not resolve this channel again.
      webhook_path_token: randomBytes(24).toString("hex"),
    })
    .eq("organization_id", org)
    .eq("id", channel.id);
  if (error) throw new SocialError("Não foi possível arquivar o canal. Tente novamente.", 500);
  // Best-effort: the channel is already out; an open health alert must not block that.
  // But the failure is not swallowed: it goes to the log and, via the route's audit
  // spread, to the audit metadata — same contract as channel-sessions/[id].
  let avisosFechados: "resolvido" | "sem_mudanca" | "falhou";
  try {
    avisosFechados = await resolverSaudeDaConexaoRemovida(db, {
      id: channel.id,
      organization_id: org,
      status: "STOPPED",
    });
  } catch (err) {
    avisosFechados = "falhou";
    logger.warn("Falha ao fechar os avisos de saúde da conexão social removida", {
      channel_session_id: channel.id,
      organization_id: org,
      erro: err instanceof Error ? err.message : String(err),
    });
  }
  // A conta pode ter sido pausada em Conexões (o mesmo PATCH …/disabled): o aviso
  // de pausa resolve aqui, ou ficaria pedindo para retomar um canal arquivado.
  // Best-effort e nunca lança, como o fechador de saúde acima (issue #2389).
  await fecharAvisoDePausaDoCanalArquivado(db, { id: channel.id, organization_id: org });
  return {
    channel_id: channel.id,
    account_removed: removeAccount && listed,
    avisos_fechados: avisosFechados,
  };
}
