/**
 * Credenciais do canal Datafy — **por sessão**, com env como fallback.
 *
 * O Datafy é um parceiro homologado pela Meta que espelha a Cloud API: o dialeto
 * de mensagem é o mesmo, e o que muda é o HOST (`cloud.datafyapi.com.br/v1` no
 * lugar de `graph.facebook.com/v21.0`) e o TOKEN (`sk_live_…` no lugar do token
 * da Meta). Por isso a credencial é um par (`phone_number_id` + token), como no
 * canal oficial — mas resolvida pela coluna PRÓPRIA, porque os dois provedores
 * podem conviver na mesma instalação e endereçam servidores diferentes.
 *
 * A cifra usa as MESMAS RPCs do resto do repo (`fn_encrypt_oauth` /
 * `fn_decrypt_oauth`, ver `lib/webhooks/secrets.ts`).
 *
 * A busca leva a ORGANIZAÇÃO junto (issue #236): `phone_number_id` é
 * identificador do PROVIDER, duas organizações podem ter o mesmo, e
 * `maybeSingle()` com duas linhas devolve `data: null` + `PGRST116`. Sem o
 * filtro, o `null` mandaria as duas para a credencial do `.env`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";

export interface GraphPartnerCredentials {
  phoneNumberId: string;
  /** A WABA (conta) do número — é o que endereça o catálogo de modelos. */
  wabaId: string;
  token: string;
  /** Raiz do host (`https://cloud.datafyapi.com.br`). A Graph entra em `/v1`. */
  rootUrl: string;
  source: "session" | "env";
}

/** A chave da busca. `organizationId` NÃO é decoração: ver o cabeçalho. */
export interface GraphPartnerCredsLookup {
  organizationId: string;
  /** `channel_sessions.datafy_phone_number_id` — o `sessionRef` deste canal. */
  phoneNumberId: string;
}

/**
 * Raiz da API. Explícita e sobrescrevível: o `.env.example` entrega a chave
 * VAZIA prometendo "vazio usa a produção", então `||` e `trim()` juntos — string
 * vazia é valor e passaria pelo `??`, montando URL sem host.
 */
export function graphPartnerRootUrl(): string {
  return process.env.DATAFY_API_BASE_URL?.trim() || "https://cloud.datafyapi.com.br";
}

/** Base dos endpoints Graph-compatíveis: `{raiz}/v1`. */
export function graphPartnerGraphBase(): string {
  return `${graphPartnerRootUrl()}/v1`;
}

/**
 * Credencial do ambiente. `null` quando não configurada — o chamador trata como
 * canal não conectado (noop), nunca como erro.
 */
export function graphPartnerCredsFromEnv(): GraphPartnerCredentials | null {
  const phoneNumberId = process.env.DATAFY_PHONE_NUMBER_ID;
  const token = process.env.DATAFY_API_KEY;
  if (!phoneNumberId || !token) return null;
  return {
    phoneNumberId,
    wabaId: process.env.DATAFY_WABA_ID ?? "",
    token,
    rootUrl: graphPartnerRootUrl(),
    source: "env",
  };
}

/**
 * Credencial gravada na sessão DESTA ORGANIZAÇÃO que atende este número.
 *
 * `null` = "esta sessão não tem token gravado"; o chamador cai no env. NÃO é
 * erro. **LANÇA quando a consulta falha** — descartar o `error` foi metade do
 * defeito da issue #236.
 */
export async function graphPartnerCredsForPhoneNumberId(
  admin: SupabaseClient,
  lookup: GraphPartnerCredsLookup,
): Promise<GraphPartnerCredentials | null> {
  const { organizationId, phoneNumberId } = lookup;
  if (!organizationId || !phoneNumberId) return null;

  const base = () =>
    admin
      .from("channel_sessions")
      .select("datafy_phone_number_id, datafy_waba_id, datafy_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("datafy_phone_number_id", phoneNumberId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `graph_partner_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  const cifrado = data?.datafy_token_encrypted;
  if (!data || !cifrado) return null;

  const token = await decryptWebhookSecret(admin, cifrado as unknown as string);
  if (!token) return null;

  return {
    phoneNumberId: data.datafy_phone_number_id as string,
    wabaId: (data.datafy_waba_id as string | null) ?? "",
    token,
    rootUrl: graphPartnerRootUrl(),
    source: "session",
  };
}

/** Sessão primeiro, env como fallback — a ordem que faz a tela vencer o `.env`. */
export async function resolveGraphPartnerCreds(
  admin: SupabaseClient,
  lookup: GraphPartnerCredsLookup,
): Promise<GraphPartnerCredentials | null> {
  return (await graphPartnerCredsForPhoneNumberId(admin, lookup)) ?? graphPartnerCredsFromEnv();
}
