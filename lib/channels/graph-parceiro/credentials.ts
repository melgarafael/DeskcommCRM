/**
 * Canal Datafy — o interruptor da instalação e a credencial **por sessão**.
 *
 * Recorte do PR #1130, de @vgamkt. O Datafy é parceiro homologado pela Meta que
 * espelha a Cloud API: o dialeto de mensagem é o mesmo, e o que muda é o HOST e
 * o TOKEN (`sk_live_…` no lugar do token da Meta). Por isso a credencial é um
 * par (`phone_number_id` + token), como no canal oficial — mas resolvida pela
 * coluna PRÓPRIA, porque os dois podem conviver na mesma instalação.
 *
 * ─── Desligado por padrão (decisão do dono, doc 54, opção b) ────────────────
 *
 * Canal opcional da INSTALAÇÃO, no molde da telefonia e da chamada de voz: sem
 * `DATAFY_ENABLED=true` no `.env`, quem instala não vê aba, a rota de conexão
 * responde 404, o webhook não aceita entrega e o envio não sai. Pôr o nome de
 * um fornecedor na tela de todo cliente seria propaganda que o dono não
 * escolheu; quem não usa não vê nada.
 *
 * ─── Sem credencial de ambiente ─────────────────────────────────────────────
 *
 * O PR de origem aceitava também `DATAFY_API_KEY`/`DATAFY_PHONE_NUMBER_ID` no
 * `.env` como reserva. Ficaram de fora: uma credencial da INSTALAÇÃO serviria a
 * qualquer organização cuja sessão não tivesse token, e a regra aqui é
 * credencial por organização, cifrada, colada pela tela.
 *
 * A busca leva a ORGANIZAÇÃO junto (issue #236): `phone_number_id` é
 * identificador do PROVIDER, e `maybeSingle()` com duas linhas devolve
 * `PGRST116`. A cifra é a mesma do outro parceiro (`fn_encrypt_oauth` via
 * `lib/webhooks/secrets.ts`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";

/**
 * A instalação liga este canal?
 *
 * Só `true` literal liga (sem diferenciar caixa, com `trim`): um `.env` escrito
 * à mão com `1`, `sim` ou espaço sobrando não pode ligar o canal por acidente.
 * O parâmetro existe para o teste; em produção o padrão lê o ambiente.
 */
export function canalGraphParceiroLigado(
  valor: string | undefined = process.env.DATAFY_ENABLED,
): boolean {
  return (valor ?? "").trim().toLowerCase() === "true";
}

/** Como o canal se chama PARA O USUÁRIO — a tela não pode escrever a marca. */
export const GRAPH_PARTNER_LABEL = "Datafy";

export interface GraphPartnerCredentials {
  /** A conexão (`channel_sessions.id`) — escopo do espelho de modelos. */
  channelSessionId: string;
  phoneNumberId: string;
  /** A WABA (conta) do número — é o que endereça o catálogo de modelos. */
  wabaId: string;
  token: string;
}

/**
 * Raiz da API. `||` e `trim()` juntos: o `.env.example` entrega a chave VAZIA
 * prometendo "vazio usa a produção", e string vazia passaria pelo `??`,
 * montando URL sem host (o defeito medido no `zernioBaseUrl`).
 */
export function graphPartnerRootUrl(): string {
  return (process.env.DATAFY_API_BASE_URL?.trim() || "https://cloud.datafyapi.com.br").replace(
    /\/+$/,
    "",
  );
}

/** Base dos endpoints Graph-compatíveis: `{raiz}/v1`. */
export function graphPartnerGraphBase(): string {
  return `${graphPartnerRootUrl()}/v1`;
}

/**
 * Credencial gravada na sessão DESTA ORGANIZAÇÃO que atende este número.
 *
 * `null` = não há token gravado (canal não conectado). **LANÇA quando a
 * consulta falha** — descartar o `error` foi metade do defeito da issue #236.
 */
export async function resolveGraphPartnerCreds(
  admin: SupabaseClient,
  lookup: { organizationId: string; phoneNumberId: string },
): Promise<GraphPartnerCredentials | null> {
  const { organizationId, phoneNumberId } = lookup;
  if (!organizationId || !phoneNumberId) return null;

  const base = () =>
    admin
      .from("channel_sessions")
      .select("id, datafy_phone_number_id, datafy_waba_id, datafy_token_encrypted")
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

  const cifrado = (data as { datafy_token_encrypted?: unknown } | null)?.datafy_token_encrypted;
  if (!data || !cifrado) return null;

  const token = await decryptWebhookSecret(admin, cifrado as string);
  if (!token) return null;

  const linha = data as { id: string; datafy_phone_number_id: string; datafy_waba_id?: string | null };
  return {
    channelSessionId: linha.id,
    phoneNumberId: linha.datafy_phone_number_id,
    wabaId: linha.datafy_waba_id ?? "",
    token,
  };
}
