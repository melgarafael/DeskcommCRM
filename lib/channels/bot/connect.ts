/**
 * Conexão do bot do Telegram — do lado de dentro do seam (issue #3440, T1).
 *
 * A rota e a tela não podem nomear o provider nem as colunas dele (invariante 1
 * de `docs/doctrine/restricao-de-canal.md`, vigiado por `lint:channels`); elas
 * falam em "o token do robô" e "a URL do webhook". A leitura, a escrita e o
 * `setWebhook` moram aqui.
 *
 * ─── Os dois segredos, e por que são dois ──────────────────────────────────
 *
 *   • o TOKEN do bot (@BotFather) deixa a gente falar com o Telegram;
 *   • o `secret_token` que NÓS inventamos deixa o Telegram falar com a gente:
 *     ele volta em todo update, no cabeçalho `X-Telegram-Bot-Api-Secret-Token`,
 *     e é a única prova de origem que este canal tem (a plataforma não assina o
 *     corpo). Ele vive em `webhook_secret_encrypted`, a MESMA coluna dos outros
 *     canais — a rota neutra do webhook já decifra de lá e entrega ao seam sem
 *     saber de quem é.
 *
 * Toda consulta leva `organization_id` À MÃO: o client é de service role e
 * ignora a RLS.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

import { CHANNEL_PROVIDER_TELEGRAM } from "../capabilities";
import { reactivateChannelSession } from "../reactivate";
import { telegramGetMe, telegramRequest, type TelegramBotInfo } from "./credentials";

/** Como o canal se chama PARA O USUÁRIO (o nome comercial é dado, não escolha da tela). */
export const ROTULO_DO_CANAL = "Telegram";

export const TELEGRAM_CHANNEL_PROVIDER = CHANNEL_PROVIDER_TELEGRAM;

/** O mesmo valor com nome neutro, para quem mora fora de `lib/channels/` (`lint:channels`). */
export const BOT_CHANNEL_PROVIDER = CHANNEL_PROVIDER_TELEGRAM;

export interface TelegramSession {
  id: string;
  botId: string | null;
  displayName: string | null;
  status: string | null;
  webhookPathToken: string | null;
  hasToken: boolean;
  webhookSecretEncrypted: string | null;
  archivedAt: string | null;
}

const COLUNAS =
  "id, telegram_bot_id, display_name, status, webhook_path_token, telegram_token_encrypted, webhook_secret_encrypted, archived_at";

function toSessao(row: Record<string, unknown> | null): TelegramSession | null {
  if (!row) return null;
  return {
    id: row.id as string,
    botId: (row.telegram_bot_id as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    hasToken: !!row.telegram_token_encrypted,
    webhookSecretEncrypted: (row.webhook_secret_encrypted as string) ?? null,
    archivedAt: (row.archived_at as string) ?? null,
  };
}

/**
 * A sessão deste canal na organização — a ATIVA primeiro. Reconectar por cima de
 * uma arquivada precisa trazer a linha de volta, não criar outra ao lado.
 *
 * LANÇA quando a consulta falha: "não há sessão" e "não consegui perguntar"
 * levam a desfechos diferentes (conectar de novo × tentar depois).
 */
export async function acharSessaoDoRobo(
  admin: SupabaseClient,
  organizationId: string,
): Promise<TelegramSession | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .eq("provider", TELEGRAM_CHANNEL_PROVIDER)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`telegram_session_lookup_failed: ${error.message}`);
  return toSessao((data as Record<string, unknown>[] | null)?.[0] ?? null);
}

/**
 * O `secret_token` que o Telegram devolve em todo update.
 *
 * Aleatório e NOVO a cada conexão: reconectar é o gesto de quem desconfia de
 * vazamento, e reciclar o segredo anterior deixaria a janela aberta. 32 bytes em
 * hex cabem no que a plataforma aceita (1 a 256 caracteres de `A-Za-z0-9_-`).
 */
export function novoSegredoDoWebhook(): string {
  return randomBytes(32).toString("hex");
}

/** O token do caminho neutro do webhook (`/api/v1/webhooks/channel/<token>`). */
export function novoTokenDeCaminho(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Registra a URL de entrega no Telegram.
 *
 * `allowed_updates: ["message"]` e não o padrão: o padrão entrega TUDO (edição,
 * callback, membros de chat), e cada um desses eventos seria lido, recusado e
 * devolvido 200 no nosso caminho — tráfego que não serve para nada. A T2
 * (#3440) acrescenta o que precisar.
 *
 * `drop_pending_updates: false`: um update que chegou enquanto a URL estava
 * errada pode ser a única mensagem de um cliente. Descartar em massa no momento
 * da conexão seria perder exatamente o que o operador foi conectar para ver.
 */
export async function registrarWebhookDoBot(
  token: string,
  url: string,
  secretToken: string,
): Promise<void> {
  await telegramRequest<boolean>(token, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
}

/**
 * O robô já atende por OUTRA conexão ativa — desta ou de outra organização?
 *
 * Pergunta feita ANTES do `setWebhook`: o índice único do robô ativo protege a
 * gravação, mas chega tarde para o efeito no fornecedor, que já teria trocado
 * a URL e o segredo de quem atendia. Recusar aqui deixa a conexão existente
 * intacta. A resposta é só sim/não: nada da outra conexão sai daqui.
 *
 * ponytail: consulta e gravação não são atômicas; duas conexões simultâneas do
 * mesmo robô ainda chegam ao índice único. Reserva com trava, se isso aparecer.
 *
 * LANÇA quando a consulta falha: na dúvida, não se mexe no webhook de ninguém.
 */
export async function roboLigadoEmOutraConexao(
  admin: SupabaseClient,
  botId: string,
  sessaoPropria: string | null,
): Promise<boolean> {
  let q = admin
    .from("channel_sessions")
    .select("id")
    .eq("provider", TELEGRAM_CHANNEL_PROVIDER)
    .eq("telegram_bot_id", botId)
    .is("archived_at", null);
  if (sessaoPropria) q = q.neq("id", sessaoPropria);
  const { data, error } = await q.limit(1);
  if (error) throw new Error(`telegram_bot_lookup_failed: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * Grava (ou ressuscita) a sessão com o token recém-validado.
 *
 * O `webhook_secret_encrypted` é NOT NULL na tabela e, neste canal, guarda o
 * `secret_token` do `setWebhook` — por isso ele entra SEMPRE, junto com o token:
 * gravar a sessão sem ele deixaria um canal "conectado" que recusa todo update.
 */
export async function salvarSessaoDoRobo(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existente: TelegramSession | null;
    botId: string;
    tokenEncrypted: string;
    secretTokenEncrypted: string;
    webhookPathToken: string;
    displayName: string;
    userId: string;
    requestId: string;
  },
): Promise<{ error: string | null; channelSessionId: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: TELEGRAM_CHANNEL_PROVIDER,
    telegram_bot_id: input.botId,
    telegram_token_encrypted: input.tokenEncrypted,
    webhook_secret_encrypted: input.secretTokenEncrypted,
    webhook_path_token: input.webhookPathToken,
    display_name: input.displayName,
    status: "WORKING",
  };

  if (input.existente) {
    // Reconectar é RESSUSCITAR: o mesmo update devolve credencial e linha à
    // vida, e a auditoria da volta sai de `reactivateChannelSession`.
    const r = await reactivateChannelSession(
      admin,
      {
        organizationId: input.organizationId,
        channelSessionId: input.existente.id,
        archivedAt: input.existente.archivedAt,
      },
      linha,
      {
        userId: input.userId,
        requestId: input.requestId,
        metadata: { provider: TELEGRAM_CHANNEL_PROVIDER, telegram_bot_id: input.botId },
      },
    );
    return { error: r.error?.message ?? null, channelSessionId: input.existente.id };
  }

  const { data, error } = await admin
    .from("channel_sessions")
    .insert({ ...linha, metadata: metadataInicialDoCanal() })
    .select("id")
    .maybeSingle();
  return {
    error: error?.message ?? null,
    channelSessionId: (data as { id: string } | null)?.id ?? null,
  };
}

export interface ResultadoDaConexao {
  ok: true;
  bot: TelegramBotInfo;
  channelSessionId: string;
  webhookUrl: string;
}

export type DesfechoDaConexao =
  | ResultadoDaConexao
  | { ok: false; reason: string; status: number };

/**
 * O gesto inteiro: confere o token, inventa os dois segredos, registra a URL no
 * Telegram e só então grava a sessão.
 *
 * ─── A ordem não é acidente ────────────────────────────────────────────────
 *
 * `setWebhook` ANTES do INSERT. Se a plataforma recusar a URL (HTTP numa
 * instalação sem TLS, host que não resolve), nada fica gravado e o operador vê o
 * erro real — em vez de uma conexão "ligada" que nunca recebe mensagem. O custo
 * do caminho contrário é o pior desfecho possível: a tela verde e o cliente sem
 * resposta.
 *
 * Se o INSERT falhar depois disso, o webhook fica apontando para um token que
 * não existe na base; a rota responde 404 ao Telegram e ele reentrega. É
 * reversível — reconectar sobrescreve o webhook —, e por isso a ordem escolhida
 * é esta.
 */
export async function conectarRobo(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    token: string;
    existente: TelegramSession | null;
    webhookUrlBase: string;
    userId: string;
    requestId: string;
  },
): Promise<DesfechoDaConexao> {
  const token = input.token.trim();
  if (!token) return { ok: false, reason: "Informe o token do robô.", status: 422 };

  let bot: TelegramBotInfo;
  try {
    bot = await telegramGetMe(token);
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "";
    // 401 é o token inválido/revogado — o único desfecho em que trocar o token
    // resolve. Rede caída não é credencial errada, e dizer "token inválido"
    // mandaria o operador caçar o problema no lugar errado.
    if (/\b401\b/.test(detalhe)) {
      return { ok: false, reason: "O Telegram recusou este token. Confira o token do @BotFather.", status: 422 };
    }
    return { ok: false, reason: "Não foi possível falar com o Telegram. Tente de novo.", status: 502 };
  }

  let emUso: boolean;
  try {
    emUso = await roboLigadoEmOutraConexao(admin, bot.id, input.existente?.id ?? null);
  } catch {
    return { ok: false, reason: "Não foi possível conferir o robô agora. Tente de novo.", status: 503 };
  }
  if (emUso) {
    return {
      ok: false,
      reason: "Este robô já está conectado em outra conta. Desconecte-o lá antes, ou crie outro robô no @BotFather.",
      status: 409,
    };
  }

  const tokenEncrypted = await encryptWebhookSecret(admin, token);
  const secretToken = novoSegredoDoWebhook();
  const secretEncrypted = await encryptWebhookSecret(admin, secretToken);
  if (!tokenEncrypted || !secretEncrypted) {
    // Sem a cifra, gravar o token em claro seria pior que recusar.
    return { ok: false, reason: "Cifra indisponível nesta instalação — a chave não foi gravada.", status: 422 };
  }

  // O token do caminho é reaproveitado quando já existe: a URL já pode estar
  // configurada em outro lugar, e trocá-la a cada reconexão renomearia o canal
  // para quem o depura.
  const webhookPathToken = input.existente?.webhookPathToken ?? novoTokenDeCaminho();
  const webhookUrl = `${input.webhookUrlBase}/api/v1/webhooks/channel/${webhookPathToken}`;

  try {
    await registrarWebhookDoBot(token, webhookUrl, secretToken);
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : "";
    return { ok: false, reason: `O Telegram recusou a URL do webhook. ${detalhe}`.trim(), status: 502 };
  }

  // O nome do robô batiza a conexão; depois dela o nome é do operador
  // (Renomear), e salvar o token de novo não o apaga.
  const displayName =
    input.existente?.displayName ||
    bot.firstName ||
    (bot.username ? `@${bot.username}` : ROTULO_DO_CANAL);

  const { error, channelSessionId } = await salvarSessaoDoRobo(admin, {
    organizationId: input.organizationId,
    existente: input.existente,
    botId: bot.id,
    tokenEncrypted,
    secretTokenEncrypted: secretEncrypted,
    webhookPathToken,
    displayName,
    userId: input.userId,
    requestId: input.requestId,
  });
  if (error || !channelSessionId) {
    return { ok: false, reason: error ?? "Não foi possível gravar a conexão.", status: 500 };
  }

  return { ok: true, bot, channelSessionId, webhookUrl };
}

/**
 * Desfaz no fornecedor o que a conexão fez: apaga o webhook do robô.
 *
 * Chamada pela exclusão neutra da conexão (`DELETE /api/v1/channel-sessions/[id]`)
 * ANTES de a linha ser arquivada — depois disso o token cifrado é o único
 * caminho para o robô, e a URL antiga só responderia 404 ao fornecedor, que
 * reentrega por horas. Best-effort, como os ramos vizinhos: quem chama registra
 * o desfecho e NÃO desfaz a exclusão que o operador pediu.
 */
export async function desligarRoboNoFornecedor(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<"desfeito" | "sem_credencial"> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("telegram_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (error) throw new Error(`telegram_session_lookup_failed: ${error.message}`);
  const cifrado = (data as { telegram_token_encrypted?: string | null } | null)?.telegram_token_encrypted;
  const token = cifrado ? await decryptWebhookSecret(admin, cifrado) : null;
  if (!token) return "sem_credencial";
  // `drop_pending_updates: false`: o que ficou na fila do fornecedor volta a ser
  // entregue se a empresa reconectar o mesmo robô.
  await telegramRequest<boolean>(token, "deleteWebhook", { drop_pending_updates: false });
  return "desfeito";
}
