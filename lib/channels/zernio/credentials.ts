/**
 * Credenciais do canal intermediado — **por sessão**, com env como fallback.
 *
 * Mesmo desenho de `../meta/credentials.ts`, e de propósito: duas organizações
 * com contas diferentes na mesma instalação é o multi-tenant que o `CLAUDE.md`
 * estabelece desde o dia 1, e um segundo formato de credencial só faria o
 * self-hoster ter que aprender duas coisas.
 *
 * ─── O que muda em relação ao canal oficial ─────────────────────────────────
 *
 * Lá a credencial é um par (`phone_number_id` + token da Meta) e o `sessionRef`
 * é o próprio `phone_number_id`. Aqui o `sessionRef` é o `accountId` que o
 * INTERMEDIÁRIO devolve ao conectar a WABA, e o token é a API key DELE — não a
 * da Meta. São chaves de sistemas diferentes: mandar o token da Meta aqui
 * autentica contra o servidor errado.
 *
 * A cifra usa as MESMAS RPCs do resto do repo (`fn_encrypt_oauth` /
 * `fn_decrypt_oauth`, ver `lib/webhooks/secrets.ts`). Escrever um terceiro
 * caminho de cifra seria mais um lugar por onde a chave vaza.
 *
 * ─── Por que a busca leva a ORGANIZAÇÃO junto (issue #236) ──────────────────
 * Mesma razão do canal oficial, e o mesmo desfecho medido: `zernio_account_id`
 * é identificador do PROVIDER, duas organizações podiam ter o mesmo por
 * configuração legítima (agência, migração entre organizações), e
 * `maybeSingle()` com duas linhas devolve `data: null` + `PGRST116`. Com o
 * `error` descartado, as duas organizações passavam a enviar pela conta do
 * `.env`. Filtro aqui, índice único parcial na migration 0165, invariante em
 * `tests/unit/canal-consulta-por-organizacao.test.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface ZernioCredentials {
  accountId: string;
  apiKey: string;
  baseUrl: string;
  /**
   * De onde veio — aparece no log de diagnóstico, nunca no payload.
   * `installation` = a conta do provedor DA INSTALAÇÃO (conexão por um clique).
   */
  source: "session" | "installation" | "env";
}

/** A chave da busca. `organizationId` NÃO é decoração: ver o cabeçalho. */
export interface ZernioCredsLookup {
  /** Resolvido de fonte confiável (sessão, linha já escopada, token do webhook). */
  organizationId: string;
  /** `channel_sessions.zernio_account_id` — o `sessionRef` deste canal. */
  accountId: string;
}

/**
 * Base da API. Explícita e sobrescrevível: o próprio provider publica um
 * servidor local no OpenAPI, e um teste de integração precisa apontar para
 * outro lugar sem editar código.
 *
 * `||` e não `??`, e o `trim()` junto — a diferença é o bug inteiro.
 *
 * O `.env.example` entrega esta chave VAZIA, e o comentário ao lado dela
 * promete: "Vazio usa a produção do provedor." O `??` não cumpria essa
 * promessa, porque ele só cai no padrão em `null`/`undefined` — string vazia
 * é valor, e passa. Quem fizesse `cp .env.example .env`, preenchesse as duas
 * credenciais e deixasse este override como veio — que é o caminho NORMAL,
 * já que o override existe só para homologação — resolvia `baseUrl` para
 * `""`, montava `/v1/inbox/conversations` sem host, e o `fetch` do Node
 * recusava com `TypeError: Failed to parse URL`. Todo envio pelo canal
 * quebrava, nos DOIS caminhos de credencial (env e sessão cifrada), que
 * chamam esta mesma função.
 *
 * Ausente funcionava e vazia não: por isso a doutrina de QA — que manda testar
 * com os envs opcionais AUSENTES — passava por cima. Quem copia o exemplo não
 * tem a var ausente, tem ela presente e vazia.
 */
export function zernioBaseUrl(): string {
  return process.env.ZERNIO_API_BASE_URL?.trim() || "https://zernio.com/api";
}

/**
 * A chave da conta do provedor DA INSTALAÇÃO — a que conecta números com um
 * clique (`lib/channels/conexao-um-clique.ts`). `null` = não configurada, e a
 * tela mostra só a conexão por chave própria.
 *
 * Lida pelo resolvedor a cada chamada, nunca guardada em memória: trocá-la na
 * tela vale na hora para todas as sessões que apontam para ela, inclusive no
 * worker, que é outro processo.
 */
export async function chaveDaInstalacao(): Promise<string | null> {
  const { valor } = await valorDaInstalacao("ZERNIO_PLATFORM_API_KEY");
  return valor?.trim() || null;
}

/**
 * Credencial do ambiente. `null` quando não configurada — o chamador trata como
 * canal não conectado (noop), nunca como erro.
 */
export function zernioCredsFromEnv(): ZernioCredentials | null {
  const accountId = process.env.ZERNIO_ACCOUNT_ID;
  const apiKey = process.env.ZERNIO_API_KEY;
  if (!accountId || !apiKey) return null;
  return { accountId, apiKey, baseUrl: zernioBaseUrl(), source: "env" };
}

/**
 * Credencial gravada na sessão DESTA ORGANIZAÇÃO que atende esta conta.
 *
 * `null` significa "esta sessão não tem chave gravada" — o chamador cai no env.
 * NÃO significa erro.
 *
 * **LANÇA quando a consulta falha.** Ver o cabeçalho: descartar o `error` era
 * metade do defeito da issue #236 — a colisão devolvia `data: null` com
 * `PGRST116`, e o `null` mandava as duas organizações para a conta do `.env`.
 */
export async function zernioCredsForAccountId(
  admin: SupabaseClient,
  lookup: ZernioCredsLookup,
): Promise<ZernioCredentials | null> {
  const { organizationId, accountId } = lookup;
  if (!organizationId || !accountId) return null;

  // `organization_id` À MÃO (service role bypassa RLS) e `archived_at is null`
  // pelo MESMO recorte do índice único `channel_sessions_zernio_account_id_ativo_unique`
  // (migration 0165): fora do recorte a trava do banco não alcança, e a busca
  // deixaria de ser exata exatamente onde ninguém a garante.
  const base = () =>
    admin
      .from("channel_sessions")
      .select("zernio_account_id, zernio_token_encrypted, zernio_credencial_da_instalacao")
      .eq("organization_id", organizationId)
      .eq("zernio_account_id", accountId);
  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );
  if (error) {
    throw new Error(
      `zernio_creds_lookup_failed: ${error.code ?? "sem_codigo"} ${error.message ?? ""}`.trim(),
    );
  }

  if (!data) return null;

  // Ponteiro, não cópia (migration 9093): a sessão conectada por um clique fala
  // pela chave da instalação, resolvida agora. Sem ela configurada, `null` — o
  // mesmo "sem chave gravada" de sempre, e o chamador cai no env.
  if (data.zernio_credencial_da_instalacao === true) {
    const daInstalacao = await chaveDaInstalacao();
    if (!daInstalacao) return null;
    return {
      accountId: data.zernio_account_id as string,
      apiKey: daInstalacao,
      baseUrl: zernioBaseUrl(),
      source: "installation",
    };
  }

  const cifrado = data.zernio_token_encrypted;
  if (!cifrado) return null;

  const apiKey = await decryptWebhookSecret(admin, cifrado as unknown as string);
  // Decifra que falha devolve null: a chave (GUC) pode não estar configurada
  // nesta instalação. Cair no env é melhor que derrubar o envio — e o `source`
  // no retorno deixa a diferença visível para quem depura.
  if (!apiKey) return null;

  return {
    accountId: data.zernio_account_id as string,
    apiKey,
    baseUrl: zernioBaseUrl(),
    source: "session",
  };
}

/**
 * A credencial em vigor para esta conta: **sessão primeiro, env como fallback**.
 *
 * A ordem é sessão-primeiro de propósito: com a chave gravada, o env deixa de
 * ter efeito. Se fosse o contrário, um env esquecido silenciaria a configuração
 * da tela e o operador não entenderia por que nada mudou.
 */
export async function resolveZernioCreds(
  admin: SupabaseClient,
  lookup: ZernioCredsLookup,
): Promise<ZernioCredentials | null> {
  return (await zernioCredsForAccountId(admin, lookup)) ?? zernioCredsFromEnv();
}
