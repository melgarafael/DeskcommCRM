/**
 * O GATEWAY DE PAGAMENTO EM VIGOR PARA UMA ORGANIZAÇÃO (issue #4058, fatia 1).
 *
 * ─── O que muda em relação a hoje ────────────────────────────────────────────
 *
 * Hoje o provedor de pagamento é da INSTALAÇÃO: `lib/cobranca/configuracao.ts`
 * lê `COBRANCA_PROVEDOR` + a chave de `platform_config` e serve a cobrança do
 * revendedor contra as empresas. Não há nada que deixe a EMPRESA cobrar o
 * cliente dela: `git grep -n "organization_id" lib/cobranca` só devolve a
 * organização COBRADA, nunca a conta de gateway que cobra.
 *
 * Aqui a ordem é: **linha da organização vence → ausência herda a instalação**.
 * Quem chama (a fatia que emite a cobrança) não escolhe provedor nem lê chave:
 * pede o gateway em vigor para UMA organização e recebe provider + modo +
 * credenciais já decifradas.
 *
 * ─── As três recusas que valem dinheiro ─────────────────────────────────────
 *
 * 1. **Credencial de OUTRA organização nunca é usada.** A busca filtra por
 *    `organization_id` numa PK, mas o filtro sozinho não é a garantia: o
 *    defeito medido na #236 foi um `maybeSingle()` devolvendo `data: null` com
 *    `error` descartado, e o `null` mandava as duas organizações para a
 *    credencial do `.env`. Então a linha RELIDA passa por conferência explícita
 *    (`organization_id !== pedido` → `credencial_de_outra_organizacao`) e todo
 *    erro de leitura é erro NOMEADO — nunca "não configurado", que herdaria a
 *    chave da instalação em silêncio.
 * 2. **Credencial ilegível não herda.** Se a linha existe e o envelope não abre
 *    (`AI_CRED_AES_KEY` ausente/trocada, ciphertext corrompido), o resultado é
 *    `credencial_ilegivel`. Cair para a chave da instalação aqui seria pior que
 *    falhar: a venda do cliente passaria a cair na conta de outra pessoa, sem
 *    ninguém perceber.
 * 3. **Desligar não apaga.** `is_active = false` volta a herdar a instalação e
 *    MANTÉM a credencial na linha — a cobrança já emitida referencia esta
 *    configuração, e apagar deixaria a história sem a conta que recebeu.
 *
 * ─── O que nunca sai daqui para a tela ──────────────────────────────────────
 *
 * `estadoParaTela()` devolve provedor, modo, `last4` e origem — nunca a chave,
 * nem a da organização nem a da instalação. A view
 * `organization_payment_gateways_safe` já omite as colunas cifradas; esta
 * função é a segunda barreira, para o payload da rota não depender de alguém
 * lembrar de não selecionar a coluna.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { adaptador } from "@/lib/cobranca/provedores";
import { chaveDoProvedor, provedorDaInstalacao, segredoDoWebhook } from "@/lib/cobranca/configuracao";
import { byteaToBuffer, bufToBytea, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";

import { modoDaChave } from "./modo-da-chave";
import {
  ehProvedorDePagamento,
  MODOS_DE_PAGAMENTO,
  type ModoDePagamento,
  type ProvedorDePagamento,
} from "./vocabulario";

/** O gateway em vigor. `apiKey` é plaintext: só para o servidor que chama o provedor. */
export interface GatewayEfetivo {
  readonly provider: ProvedorDePagamento;
  readonly modo: ModoDePagamento;
  readonly apiKey: string;
  /** Só do MESMO escopo de `apiKey` — nunca o segredo da instalação para uma conta da organização. */
  readonly webhookSecret: string | null;
  /** De onde veio. Vai para log/auditoria, nunca para o corpo da resposta. */
  readonly origem: "organizacao" | "instalacao";
}

export const ERROS_DO_GATEWAY = [
  "sem_gateway",
  "credencial_ilegivel",
  "credencial_de_outra_organizacao",
  "leitura_falhou",
] as const;
export type ErroDoGateway = (typeof ERROS_DO_GATEWAY)[number];

export type ResultadoDoGateway =
  | { ok: true; gateway: GatewayEfetivo }
  | { ok: false; erro: ErroDoGateway };

/** O que a TELA vê. Não há `apiKey` neste tipo — e é de propósito. */
export interface EstadoDoGatewayParaTela {
  /** `organizacao` = linha própria ligada; `instalacao` = herdando; `nenhuma` = ninguém configurou. */
  readonly origem: "organizacao" | "instalacao" | "nenhuma";
  readonly provider: ProvedorDePagamento | null;
  readonly modo: ModoDePagamento | null;
  /** Só da chave da PRÓPRIA organização; herdada não expõe nem os 4 últimos. */
  readonly apiKeyLast4: string | null;
  readonly webhookSecretLast4: string | null;
  /** Existe linha própria (ligada ou desligada)? A tela usa para oferecer "desligar". */
  readonly configurada: boolean;
  readonly isActive: boolean;
}

interface LinhaDoGateway {
  organization_id: string;
  provider: string;
  mode: string;
  api_key_encrypted: unknown;
  api_key_iv: unknown;
  api_key_tag: unknown;
  api_key_last4: string;
  webhook_secret_encrypted: unknown;
  webhook_secret_iv: unknown;
  webhook_secret_tag: unknown;
  webhook_secret_last4: string | null;
  is_active: boolean;
}

const COLUNAS_DA_LINHA =
  "organization_id, provider, mode, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4, " +
  "webhook_secret_encrypted, webhook_secret_iv, webhook_secret_tag, webhook_secret_last4, is_active";

function modoConhecido(valor: string): ModoDePagamento | null {
  return MODOS_DE_PAGAMENTO.find((m) => m === valor) ?? null;
}

/** O gateway da INSTALAÇÃO — a herança. `sem_gateway` quando ninguém configurou. */
async function gatewayDaInstalacao(): Promise<ResultadoDoGateway> {
  const provider = await provedorDaInstalacao();
  if (provider === null) return { ok: false, erro: "sem_gateway" };

  const apiKey = await chaveDoProvedor(provider);
  if (apiKey === null) return { ok: false, erro: "sem_gateway" };

  const modo = modoDaChave(provider, apiKey);
  if (modo === null) return { ok: false, erro: "sem_gateway" };

  return {
    ok: true,
    gateway: {
      provider,
      modo,
      apiKey,
      webhookSecret: await segredoDoWebhook(provider),
      origem: "instalacao",
    },
  };
}

/**
 * O gateway em vigor para a organização pedida.
 *
 * `admin` é o client de service role de propósito: a credencial não é legível
 * por RLS para ninguém (a tabela base expõe só ciphertext), e quem decide QUEM
 * pode pedir é a rota, com `requireRole`.
 */
export async function gatewayDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
): Promise<ResultadoDoGateway> {
  if (!organizationId) return { ok: false, erro: "sem_gateway" };

  const { data, error } = await admin
    .from("organization_payment_gateways")
    .select(COLUNAS_DA_LINHA)
    .eq("organization_id", organizationId)
    .maybeSingle();

  // Erro de leitura NÃO é "não configurado": herdar aqui usaria a chave da
  // instalação para a venda de um cliente que talvez tenha a própria.
  if (error) return { ok: false, erro: "leitura_falhou" };

  const linha = (data as LinhaDoGateway | null) ?? null;
  if (linha === null) return gatewayDaInstalacao();

  // Barreira explícita, além do filtro: uma linha de OUTRA organização nunca é
  // usada, nem que um dia a consulta mude.
  if (linha.organization_id !== organizationId) {
    return { ok: false, erro: "credencial_de_outra_organizacao" };
  }

  if (!linha.is_active) return gatewayDaInstalacao();

  if (!ehProvedorDePagamento(linha.provider)) return { ok: false, erro: "leitura_falhou" };
  const provider = linha.provider;
  const modo = modoConhecido(linha.mode);
  if (modo === null) return { ok: false, erro: "leitura_falhou" };

  let apiKey: string;
  try {
    apiKey = decryptKey({
      ciphertext: byteaToBuffer(linha.api_key_encrypted),
      iv: byteaToBuffer(linha.api_key_iv),
      tag: byteaToBuffer(linha.api_key_tag),
    });
  } catch {
    return { ok: false, erro: "credencial_ilegivel" };
  }
  if (!apiKey) return { ok: false, erro: "credencial_ilegivel" };

  let webhookSecret: string | null = null;
  if (linha.webhook_secret_encrypted) {
    try {
      webhookSecret = decryptKey({
        ciphertext: byteaToBuffer(linha.webhook_secret_encrypted),
        iv: byteaToBuffer(linha.webhook_secret_iv),
        tag: byteaToBuffer(linha.webhook_secret_tag),
      });
    } catch {
      return { ok: false, erro: "credencial_ilegivel" };
    }
  }

  return { ok: true, gateway: { provider, modo, apiKey, webhookSecret, origem: "organizacao" } };
}

/**
 * O estado para a tela — provedor, modo, `last4`, origem. Sem chave, de
 * propósito: é a garantia de que o GET não devolve segredo nem por descuido de
 * quem monta o payload.
 */
export async function estadoParaTela(
  admin: SupabaseClient,
  organizationId: string,
): Promise<EstadoDoGatewayParaTela> {
  const { data } = await admin
    .from("organization_payment_gateways")
    .select("organization_id, provider, mode, api_key_last4, webhook_secret_last4, is_active")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const linha = (data as Pick<
    LinhaDoGateway,
    "organization_id" | "provider" | "mode" | "api_key_last4" | "webhook_secret_last4" | "is_active"
  > | null) ?? null;

  // Linha de outra organização é ignorada aqui (não vaza nem o `last4`): o
  // estado cai para a herança, e a rota que USA a credencial recusa em
  // `gatewayDaOrganizacao`.
  if (linha !== null && linha.organization_id === organizationId && linha.is_active) {
    if (ehProvedorDePagamento(linha.provider)) {
      return {
        origem: "organizacao",
        provider: linha.provider,
        modo: modoConhecido(linha.mode),
        apiKeyLast4: linha.api_key_last4,
        webhookSecretLast4: linha.webhook_secret_last4,
        configurada: true,
        isActive: true,
      };
    }
  }

  const herdado = await gatewayDaInstalacao();
  return {
    origem: herdado.ok ? "instalacao" : "nenhuma",
    provider: herdado.ok ? herdado.gateway.provider : null,
    modo: herdado.ok ? herdado.gateway.modo : null,
    apiKeyLast4: null,
    webhookSecretLast4: null,
    configurada: linha !== null && linha.organization_id === organizationId,
    isActive: linha !== null && linha.organization_id === organizationId ? linha.is_active : false,
  };
}

// ─── escrita ─────────────────────────────────────────────────────────────────

export const ERROS_DE_ESCRITA = [
  "credencial_obrigatoria",
  "credencial_invalida",
  "credencial_sem_permissao",
  "provedor_fora",
  "modo_divergente",
  "cifra_indisponivel",
  "banco_recusou",
] as const;
export type ErroDeEscrita = (typeof ERROS_DE_ESCRITA)[number];

export type ResultadoDaEscrita = { ok: true } | { ok: false; erro: ErroDeEscrita };

export interface PedidoDeGateway {
  admin: SupabaseClient;
  organizationId: string;
  userId: string;
  provider: ProvedorDePagamento;
  /** Nova chave em claro. `undefined` mantém a já gravada (só com o MESMO provedor). */
  apiKey?: string;
  /** `undefined` mantém; `null` apaga; string grava. */
  webhookSecret?: string | null;
  isActive: boolean;
}

/**
 * Confere a chave NO PROVEDOR antes de gravar — a mesma porta que a Conexão da
 * instalação usa (`AdaptadorDeCobranca.testarChave`), com a chave digitada
 * injetada. Sem isso, uma chave com erro de digitação só apareceria na primeira
 * cobrança: o cliente receberia um erro no meio da conversa, com o dinheiro em
 * jogo. Nenhuma resposta do provedor é repassada — só o motivo, nomeado.
 */
async function conferirChaveNoProvedor(
  provider: ProvedorDePagamento,
  apiKey: string,
): Promise<{ ok: true; modo: ModoDePagamento } | { ok: false; erro: ErroDeEscrita }> {
  const teste = await adaptador(provider, { chave: async () => apiKey }).testarChave();
  if (teste.ok) return { ok: true, modo: teste.modo };
  if (teste.motivo === "chave_invalida") return { ok: false, erro: "credencial_invalida" };
  if (teste.motivo === "sem_permissao") return { ok: false, erro: "credencial_sem_permissao" };
  if (teste.motivo === "modo_divergente") return { ok: false, erro: "modo_divergente" };
  return { ok: false, erro: "provedor_fora" };
}

export async function guardarGatewayDaOrganizacao(
  pedido: PedidoDeGateway,
): Promise<ResultadoDaEscrita> {
  const { admin, organizationId, userId, provider } = pedido;

  const { data: existente, error: erroDaLeitura } = await admin
    .from("organization_payment_gateways")
    .select("provider, mode, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4, webhook_secret_encrypted, webhook_secret_iv, webhook_secret_tag, webhook_secret_last4")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (erroDaLeitura) return { ok: false, erro: "banco_recusou" };

  const anterior = (existente as Pick<
    LinhaDoGateway,
    | "provider"
    | "mode"
    | "api_key_encrypted"
    | "api_key_iv"
    | "api_key_tag"
    | "api_key_last4"
    | "webhook_secret_encrypted"
    | "webhook_secret_iv"
    | "webhook_secret_tag"
    | "webhook_secret_last4"
  > | null) ?? null;

  const novaChave = pedido.apiKey?.trim() ? pedido.apiKey.trim() : undefined;
  // Trocar de provedor sem chave nova emparelharia a chave da Stripe com o
  // Asaas: a cobrança falharia no provedor com 401, já dentro da conversa.
  if (novaChave === undefined && (anterior === null || anterior.provider !== provider)) {
    return { ok: false, erro: "credencial_obrigatoria" };
  }

  let modo: ModoDePagamento | null = null;
  let camposDaChave: Record<string, unknown> = {};
  if (novaChave !== undefined) {
    const conferida = await conferirChaveNoProvedor(provider, novaChave);
    if (!conferida.ok) return conferida;
    modo = conferida.modo;

    let cifrada;
    try {
      cifrada = encryptKey(novaChave);
    } catch {
      return { ok: false, erro: "cifra_indisponivel" };
    }
    camposDaChave = {
      api_key_encrypted: bufToBytea(cifrada.ciphertext),
      api_key_iv: bufToBytea(cifrada.iv),
      api_key_tag: bufToBytea(cifrada.tag),
      api_key_last4: cifrada.last4,
    };
  } else if (anterior !== null) {
    // Mantém a chave gravada: o modo também é o dela, o que já está na linha.
    // Não vem da tela — um modo digitado reintroduziria o campo que esta fatia
    // recusa de propósito.
    modo = modoConhecido(anterior.mode);
    if (modo === null) return { ok: false, erro: "credencial_obrigatoria" };
    camposDaChave = {
      api_key_encrypted: anterior.api_key_encrypted,
      api_key_iv: anterior.api_key_iv,
      api_key_tag: anterior.api_key_tag,
      api_key_last4: anterior.api_key_last4,
    };
  }

  let camposDoSegredo: Record<string, unknown> = {};
  if (pedido.webhookSecret === null) {
    camposDoSegredo = {
      webhook_secret_encrypted: null,
      webhook_secret_iv: null,
      webhook_secret_tag: null,
      webhook_secret_last4: null,
    };
  } else if (typeof pedido.webhookSecret === "string" && pedido.webhookSecret.trim()) {
    let cifrado;
    try {
      cifrado = encryptKey(pedido.webhookSecret.trim());
    } catch {
      return { ok: false, erro: "cifra_indisponivel" };
    }
    camposDoSegredo = {
      webhook_secret_encrypted: bufToBytea(cifrado.ciphertext),
      webhook_secret_iv: bufToBytea(cifrado.iv),
      webhook_secret_tag: bufToBytea(cifrado.tag),
      webhook_secret_last4: cifrado.last4,
    };
  } else if (anterior !== null) {
    camposDoSegredo = {
      webhook_secret_encrypted: anterior.webhook_secret_encrypted,
      webhook_secret_iv: anterior.webhook_secret_iv,
      webhook_secret_tag: anterior.webhook_secret_tag,
      webhook_secret_last4: anterior.webhook_secret_last4,
    };
  }

  const { error } = await admin.from("organization_payment_gateways").upsert(
    {
      organization_id: organizationId,
      provider,
      mode: modo,
      ...camposDaChave,
      ...camposDoSegredo,
      is_active: pedido.isActive,
      updated_by: userId,
    },
    { onConflict: "organization_id" },
  );
  if (error) return { ok: false, erro: "banco_recusou" };

  await audit({
    action: "pagamento.gateway_configurado",
    actorUserId: userId,
    organizationId,
    resourceType: "organization_payment_gateways",
    resourceId: organizationId,
    metadata: {
      provider,
      modo,
      chave_alterada: novaChave !== undefined,
      segredo_de_webhook_alterado: pedido.webhookSecret === null || typeof pedido.webhookSecret === "string",
      ativo: pedido.isActive,
    },
  });

  return { ok: true };
}

/**
 * Desliga a configuração própria: volta a herdar a instalação e NÃO apaga a
 * linha. Apagar custaria a credencial que a cobrança já emitida referencia (e o
 * `last4` que a tela mostra), e uma chave rejeitada pelo provedor voltaria a
 * valer no dia seguinte sem ninguém saber.
 */
export async function desligarGatewayDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<ResultadoDaEscrita> {
  const { data, error } = await admin
    .from("organization_payment_gateways")
    .update({ is_active: false, updated_by: userId })
    .eq("organization_id", organizationId)
    .select("organization_id");
  if (error) return { ok: false, erro: "banco_recusou" };
  // Sem linha não há o que desligar — a organização já herda, e a resposta é a
  // mesma (desligar é idempotente).
  if (!data || (data as unknown[]).length === 0) return { ok: true };

  await audit({
    action: "pagamento.gateway_desligado",
    actorUserId: userId,
    organizationId,
    resourceType: "organization_payment_gateways",
    resourceId: organizationId,
    metadata: { herdando: "instalacao" },
  });
  return { ok: true };
}
