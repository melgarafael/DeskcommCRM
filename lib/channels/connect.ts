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
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";
import { CHANNEL_PROVIDER_ZERNIO } from "./capabilities";
import { zernioBaseUrl } from "./zernio/credentials";
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
    // A chave presta, mas não alcança esta conta. É diferente de chave inválida,
    // e a mensagem precisa dizer QUAL das duas para o operador saber o que
    // corrigir.
    return { ok: false, reason: "Conta não encontrada para esta chave." };
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
}

const COLUNAS =
  "id, zernio_account_id, phone_number, display_name, status, webhook_path_token, zernio_token_encrypted";

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
 * Grava (ou ressuscita) a sessão.
 *
 * `archived_at: null` sempre: reconectar por cima de um canal excluído precisa
 * trazê-lo de volta. Sem isso o update deixaria a coluna no lugar e o canal
 * "conectado" ficaria invisível para o webhook, o envio e os seletores — todos
 * filtrados por ela.
 */
export async function savePartnerSession(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    existingId: string | null;
    accountId: string;
    apiKeyEncrypted: string;
    webhookPathToken: string;
    webhookSecretEncrypted: string;
    phoneNumber: string | null;
    displayName: string;
  },
): Promise<{ error: string | null }> {
  const linha = {
    organization_id: input.organizationId,
    provider: PARTNER_CHANNEL_PROVIDER,
    zernio_account_id: input.accountId,
    zernio_token_encrypted: input.apiKeyEncrypted,
    webhook_path_token: input.webhookPathToken,
    webhook_secret_encrypted: input.webhookSecretEncrypted,
    phone_number: input.phoneNumber,
    display_name: input.displayName,
    status: "WORKING",
    archived_at: null,
  };

  const { error } = input.existingId
    ? await admin.from("channel_sessions").update(linha).eq("id", input.existingId)
    : await admin
        .from("channel_sessions")
        .insert({ ...linha, metadata: metadataInicialDoCanal() });

  return { error: error?.message ?? null };
}
