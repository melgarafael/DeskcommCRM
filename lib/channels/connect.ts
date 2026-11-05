/**
 * Conexão de um canal por CREDENCIAL — do lado de dentro do seam.
 *
 * A tela e a rota não podem saber qual provider é (invariante 1 da doutrina),
 * mas precisam de três coisas concretas: como se chama o canal para o usuário,
 * quais campos pedir, e se a credencial que ele colou presta. As três moram
 * aqui, onde nomear o provider é permitido.
 *
 * ─── Validar ANTES de gravar ────────────────────────────────────────────────
 *
 * Mesma decisão da conexão oficial, pelo mesmo motivo: gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender que
 * não na primeira mensagem que não sai — com o lead do outro lado esperando.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { CHANNEL_PROVIDER_ZERNIO } from "./capabilities";
import {
  apagarWebhook,
  contaEstaNoPerfil,
  desconectarConta,
  garantirWebhook,
} from "./zernio/conexao-pela-instalacao";
import { chaveDaInstalacao, zernioBaseUrl } from "./zernio/credentials";
import {
  CAMINHO_DA_ENTRADA_DA_INSTALACAO,
  idDoWebhookDaInstalacao,
  sincronizarWebhookDaInstalacao,
} from "./zernio/webhook-da-instalacao";
import type { ChannelProvider } from "./types";

/**
 * O canal conectável por credencial nesta instalação.
 *
 * Exportado como valor para que rota e tela não escrevam a string — é o que o
 * `lint:channels` cobra, e o que faz um canal seguinte trocar uma linha aqui
 * em vez de dez espalhadas.
 */
export const PARTNER_CHANNEL_PROVIDER: ChannelProvider = CHANNEL_PROVIDER_ZERNIO;

/**
 * Como o canal se chama PARA O USUÁRIO.
 *
 * O nome comercial mora aqui e não na tela por causa do lint — mas a razão é
 * anterior a ele: quem instala reconhece a marca do serviço que contratou, e a
 * tela que diz "provedor parceiro" obriga a adivinhar. O rótulo é dado, não
 * decisão de quem desenha a tela.
 */
export const PARTNER_CHANNEL_LABEL = "Zernio";

/**
 * Endpoint base do parceiro — o que a tela mostra para o operador reaproveitar
 * em outro sistema. Não é segredo (endereço público do provedor); a credencial
 * continua sem voltar nunca.
 */
export function partnerEndpoint(): string {
  return zernioBaseUrl();
}

export interface PartnerCredentialsInput {
  accountId: string;
  apiKey: string;
}

export type PartnerValidation =
  | {
      ok: true;
      /** Número conectado, para a tela confirmar que é o esperado. */
      phoneNumber: string | null;
      displayName: string | null;
      /** Qualidade do número segundo a plataforma (GREEN/YELLOW/RED). */
      qualityRating: string | null;
    }
  | { ok: false; reason: string };

/**
 * A credencial presta, e a conta é mesmo de WhatsApp?
 *
 * Confere as DUAS coisas de propósito. Uma chave válida apontando para uma
 * conta de outra rede autentica bem e falha em todo envio — e o operador veria
 * "conectado" numa tela de WhatsApp que nunca manda nada.
 */
export async function validatePartnerCredentials(
  input: PartnerCredentialsInput,
): Promise<PartnerValidation> {
  const accountId = input.accountId.trim();
  const apiKey = input.apiKey.trim();
  if (!accountId || !apiKey) return { ok: false, reason: "Informe a conta e a chave." };

  let res: Response;
  try {
    // LISTA e não `GET /accounts/{id}`: medido contra a API, o endpoint por id
    // aceita só `PUT` e responde 405 ao GET — e um 405 tratado como "credencial
    // inválida" mandaria o operador trocar uma chave que estava certa. Pior: a
    // primeira versão deste teste "passava" nos casos de recusa porque TODOS
    // recebiam 405, verde afirmando uma validação que não acontecia.
    res = await fetch(`${zernioBaseUrl()}/v1/accounts`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    // Rede caída não é credencial errada, e dizer "chave inválida" mandaria o
    // operador trocar uma chave que estava certa.
    return { ok: false, reason: "Não foi possível falar com o provedor. Tente de novo." };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "Chave recusada pelo provedor." };
  }
  if (!res.ok) {
    return { ok: false, reason: `Provedor respondeu ${res.status}.` };
  }

  const json = (await res.json().catch(() => null)) as {
    accounts?: Record<string, unknown>[];
  } | null;
  const contas = Array.isArray(json?.accounts) ? json.accounts : [];
  const conta = contas.find((c) => String(c._id ?? c.id) === accountId) ?? null;

  if (!conta) {
    // O operador colou o id do PERFIL no campo CONTA (o provedor lista perfis
    // em outro endpoint): sem distinguir, o par certo vira "não encontrada".
    // Best-effort de propósito — se a consulta falhar, cai na mensagem do caso.
    if (await pareceIdDePerfil(apiKey, accountId)) {
      return { ok: false, reason: "Este id é de um PERFIL. Aqui vai o id da CONTA." };
    }
    if (contas.length === 0) {
      // Medido contra o provedor com chave válida: sem perfil a lista vem
      // `{"accounts":[]}` — a chave presta, mas não lista nada sozinha.
      return {
        ok: false,
        reason: "A chave não lista nenhuma conta. Confira o perfil e a conta no painel do provedor.",
      };
    }
    // A chave presta, mas não alcança esta conta. É diferente de chave inválida,
    // e a mensagem precisa dizer QUAL das duas para o operador saber o que
    // corrigir.
    return {
      ok: false,
      reason: "Conta fora do alcance desta chave. Confira se a conta pertence ao perfil desta chave.",
    };
  }

  if (conta.platform !== "whatsapp") {
    return {
      ok: false,
      reason: `Esta conta é de ${String(conta.platform ?? "outra rede")}, não de WhatsApp.`,
    };
  }

  const meta = (conta.metadata ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    phoneNumber: typeof meta.displayPhoneNumber === "string" ? meta.displayPhoneNumber : null,
    displayName: typeof conta.displayName === "string" ? conta.displayName : null,
    qualityRating: typeof meta.qualityRating === "string" ? meta.qualityRating : null,
  };
}

/**
 * O id colado é de um PERFIL, não de uma CONTA?
 *
 * Confere em `GET /v1/profiles` sem adivinhar a forma do provedor: só vale o
 * que a resposta prova (lista com o id). Qualquer falha — rede, status, corpo
 * inesperado — devolve `false` e quem responde é a mensagem do caso.
 */
async function pareceIdDePerfil(apiKey: string, accountId: string): Promise<boolean> {
  try {
    const res = await fetch(`${zernioBaseUrl()}/v1/profiles`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return false;
    const json = (await res.json().catch(() => null)) as {
      profiles?: Record<string, unknown>[];
    } | null;
    const perfis = Array.isArray(json?.profiles) ? json.profiles : [];
    return perfis.some((p) => String(p._id ?? p.id) === accountId);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------

/**
 * As colunas da sessão carregam o nome do provider — e é assim que a migration
 * 0117/0118 as criou, porque o CHECK precisa saber qual exigir. Escrevê-las da
 * rota faria a rota nomear o canal, que é o que o `lint:channels` reprovou na
 * primeira versão dela.
 *
 * Então a leitura e a escrita moram aqui, e a rota fala em conceitos: "a conta",
 * "a chave", "o token do webhook".
 */
export interface PartnerSession {
  id: string;
  accountId: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  status: string | null;
  webhookPathToken: string | null;
  hasApiKey: boolean;
  archivedAt: string | null;
  /** Fala pela chave da INSTALAÇÃO (conexão por um clique), não por uma chave própria. */
  pelaInstalacao: boolean;
  /** Perfil do provedor em que a conta foi conectada (só a conexão por um clique o grava). */
  profileId: string | null;
  /** Assinatura de webhook que a instalação registrou. Nulo = configurada à mão. */
  webhookId: string | null;
}

const COLUNAS =
  "id, zernio_account_id, phone_number, display_name, status, webhook_path_token, zernio_token_encrypted, zernio_credencial_da_instalacao, zernio_profile_id, zernio_webhook_id";

function toPartnerSession(row: Record<string, unknown> | null): PartnerSession | null {
  if (!row) return null;
  return {
    id: row.id as string,
    accountId: (row.zernio_account_id as string) ?? null,
    phoneNumber: (row.phone_number as string) ?? null,
    displayName: (row.display_name as string) ?? null,
    status: (row.status as string) ?? null,
    webhookPathToken: (row.webhook_path_token as string) ?? null,
    hasApiKey: !!row.zernio_token_encrypted,
    archivedAt: (row.archived_at as string) ?? null,
    pelaInstalacao: row.zernio_credencial_da_instalacao === true,
    profileId: (row.zernio_profile_id as string) ?? null,
    webhookId: (row.zernio_webhook_id as string) ?? null,
  };
}

export async function findPartnerSession(
  admin: SupabaseClient,
  organizationId: string,
): Promise<PartnerSession | null> {
  const buscar = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", organizationId)
      .eq("provider", PARTNER_CHANNEL_PROVIDER)
      .maybeSingle();

  const { data } = await queryTolerantToMissingArchived(
    () => buscar(`${COLUNAS}, ${ARCHIVED_AT}`),
    () => buscar(COLUNAS),
  );
  return toPartnerSession(data as Record<string, unknown> | null);
}

/**
 * Grava (ou ressuscita) a sessão. Devolve o id dela.
 *
 * `archived_at: null` sempre: reconectar por cima de um canal excluído precisa
 * trazê-lo de volta. Sem isso o update deixaria a coluna no lugar e o canal
 * "conectado" ficaria invisível para o webhook, o envio e os seletores — todos
 * filtrados por ela.
 *
 * A credencial é UMA das duas (CHECK da migration 9093): a chave própria
 * cifrada, ou o ponteiro para a chave da instalação. Gravar uma apaga a outra,
 * e o webhook registrado pela instalação só fica quando quem grava o informa.
 */
export async function savePartnerSession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existingId: string | null;
    accountId: string;
    credencial: { tipo: "propria"; apiKeyEncrypted: string } | { tipo: "instalacao"; profileId: string };
    webhookPathToken: string;
    webhookSecretEncrypted: string;
    phoneNumber: string | null;
    displayName: string;
  },
): Promise<{ error: string | null; id: string | null }> {
  const pelaInstalacao = input.credencial.tipo === "instalacao";
  const linha = {
    organization_id: input.organizationId,
    provider: PARTNER_CHANNEL_PROVIDER,
    zernio_account_id: input.accountId,
    zernio_token_encrypted: input.credencial.tipo === "propria" ? input.credencial.apiKeyEncrypted : null,
    zernio_credencial_da_instalacao: pelaInstalacao,
    zernio_profile_id: input.credencial.tipo === "instalacao" ? input.credencial.profileId : null,
    zernio_webhook_id: null,
    webhook_path_token: input.webhookPathToken,
    webhook_secret_encrypted: input.webhookSecretEncrypted,
    phone_number: input.phoneNumber,
    display_name: input.displayName,
    status: "WORKING",
    archived_at: null,
  };

  if (input.existingId) {
    const { error } = await admin
      .from("channel_sessions")
      .update(linha)
      .eq("id", input.existingId)
      .eq("organization_id", input.organizationId);
    return { error: error?.message ?? null, id: error ? null : input.existingId };
  }
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({ ...linha, metadata: metadataInicialDoCanal() })
    .select("id")
    .single();
  return { error: error?.message ?? null, id: (data as { id: string } | null)?.id ?? null };
}

/**
 * O segredo de webhook que a sessão JÁ tem, em claro — para reconectar sem
 * trocar a assinatura que está entregando (nenhum evento se perde no caminho).
 * `null` quando não há sessão ou a cifra não abre: aí quem chama gera outro.
 */
export async function segredoAtualDoWebhook(
  admin: SupabaseClient,
  organizationId: string,
  sessionId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("webhook_secret_encrypted")
    .eq("organization_id", organizationId)
    .eq("id", sessionId)
    .maybeSingle();
  const cifrado = (data as { webhook_secret_encrypted?: string } | null)?.webhook_secret_encrypted;
  if (error || !cifrado) return null;
  return decryptWebhookSecret(admin, cifrado);
}

/**
 * Registra no provedor o webhook do número, FILTRADO à conta, e grava o id na
 * sessão. Devolve o id, ou `null` quando o provedor não aceitou — a chave pode
 * não ter permissão de webhook — e aí a tela volta a mostrar o que colar.
 * Nunca lança: a conexão já está gravada, e um webhook a configurar à mão é
 * melhor que uma conexão desfeita.
 */
export async function registrarWebhookDoNumero(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    sessionId: string;
    apiKey: string;
    accountId: string;
    url: string;
    segredo: string;
    segredoNovo: boolean;
  },
): Promise<string | null> {
  try {
    const webhookId = await garantirWebhook(input.apiKey, {
      url: input.url,
      segredo: input.segredo,
      segredoNovo: input.segredoNovo,
      accountId: input.accountId,
      nome: `CRM WhatsApp ${input.accountId.slice(-8)}`,
    });
    const { error } = await admin
      .from("channel_sessions")
      .update({ zernio_webhook_id: webhookId })
      .eq("organization_id", input.organizationId)
      .eq("id", input.sessionId);
    if (error) throw new Error(error.message);
    return webhookId;
  } catch (erro) {
    logger.warn("[channels.connect] webhook do número não registrado no provedor", {
      session_id: input.sessionId,
      detail: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}

/**
 * Põe o perfil desta conexão de um clique no webhook ÚNICO da instalação e grava
 * na sessão o id da assinatura que a entrega. Devolve o id, ou `null` quando o
 * provedor recusou. Nunca lança: a conexão já está gravada, e o webhook se
 * corrige na próxima conexão ou remoção (o filtro sai sempre da base).
 *
 * Uma sessão que guarda OUTRA assinatura (`legado` — a de um webhook da
 * instalação que foi recriado no provedor, por exemplo) perde a dela: as duas
 * entregariam o mesmo evento.
 */
export async function registrarNoWebhookDaInstalacao(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    sessionId: string;
    apiKey: string;
    publicBase: string;
    nome: string;
    legado: string | null;
  },
): Promise<string | null> {
  try {
    const webhookId = await sincronizarWebhookDaInstalacao(admin, input.apiKey, {
      url: `${input.publicBase}${CAMINHO_DA_ENTRADA_DA_INSTALACAO}`,
      nome: input.nome,
    });
    if (!webhookId) throw new Error("o webhook da instalação ficou sem a conexão");
    if (input.legado && input.legado !== webhookId) {
      await apagarWebhook(input.apiKey, input.legado).catch((erro: unknown) =>
        logger.warn("[channels.connect] assinatura antiga do número não apagada", {
          session_id: input.sessionId,
          detail: erro instanceof Error ? erro.message : String(erro),
        }),
      );
    }
    const { error } = await admin
      .from("channel_sessions")
      .update({ zernio_webhook_id: webhookId })
      .eq("organization_id", input.organizationId)
      .eq("id", input.sessionId);
    if (error) throw new Error(error.message);
    return webhookId;
  } catch (erro) {
    logger.warn("[channels.connect] conexão fora do webhook da instalação", {
      session_id: input.sessionId,
      detail: erro instanceof Error ? erro.message : String(erro),
    });
    return null;
  }
}

/**
 * Desfaz, no provedor, o que a INSTALAÇÃO fez por esta sessão.
 *
 *   - por chave própria: apaga a assinatura que a rota registrou para o número
 *     (a conta é da organização, o número fica lá);
 *   - por um clique: tira o perfil do webhook ÚNICO da instalação (que segue
 *     entregando as outras conexões — nunca é apagado aqui) e desconecta o
 *     número da conta da instalação, senão ele continuaria na fatura do
 *     provedor depois de sair do CRM. Uma assinatura que não é a compartilhada,
 *     se a sessão guardar uma, é apagada. Antes, o provedor confirma que a
 *     conta está no perfil desta organização: a chave da instalação alcança
 *     todos os números, e a linha sozinha não prova de quem a conta é.
 *
 * Roda ANTES do patch de exclusão (que gira o token). Erro do provedor LANÇA;
 * quem chama decide seguir em best-effort.
 */
export async function desfazerNoProvedor(
  admin: SupabaseClient,
  organizationId: string,
  sessionId: string,
): Promise<"desfeito" | "nada_a_desfazer" | "sem_credencial"> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select(
      "zernio_account_id, zernio_token_encrypted, zernio_credencial_da_instalacao, zernio_webhook_id, zernio_profile_id",
    )
    .eq("organization_id", organizationId)
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(`sessão não lida: ${error.message}`);
  const linha = data as {
    zernio_account_id: string | null;
    zernio_token_encrypted: string | null;
    zernio_credencial_da_instalacao: boolean | null;
    zernio_webhook_id: string | null;
    zernio_profile_id: string | null;
  } | null;
  if (!linha) return "nada_a_desfazer";
  const pelaInstalacao = linha.zernio_credencial_da_instalacao === true;
  if (!linha.zernio_webhook_id && !pelaInstalacao) return "nada_a_desfazer";
  const chave = pelaInstalacao
    ? await chaveDaInstalacao()
    : linha.zernio_token_encrypted
      ? await decryptWebhookSecret(admin, linha.zernio_token_encrypted)
      : null;
  if (!chave) return "sem_credencial";
  if (!pelaInstalacao) {
    if (linha.zernio_webhook_id) await apagarWebhook(chave, linha.zernio_webhook_id);
    return "desfeito";
  }
  const conta = linha.zernio_account_id;
  const perfil = linha.zernio_profile_id;
  if (conta && perfil && (await contaEstaNoPerfil(chave, perfil, conta))) {
    const compartilhado = await idDoWebhookDaInstalacao();
    if (linha.zernio_webhook_id && linha.zernio_webhook_id !== compartilhado) {
      await apagarWebhook(chave, linha.zernio_webhook_id);
    }
    await desconectarConta(chave, conta);
  } else if (conta) {
    logger.warn("[channels.connect] conta fora do perfil da organização: nada desconectado no provedor", {
      session_id: sessionId,
      organization_id: organizationId,
    });
  }
  await sincronizarWebhookDaInstalacao(admin, chave, { nome: "", excluirSessao: sessionId });
  return "desfeito";
}
