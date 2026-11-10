/**
 * Adapter do chat da OLX (issue #2927) — o tradutor de formato e o envio.
 *
 * Burro como os irmãos: traduz formato e nada mais. Janela, cap diário e
 * horário vivem na cadeia `before_send` (`docs/doctrine/restricao-de-canal.md`).
 *
 * ─── O ciclo, medido contra a doc pública da OLX ────────────────────────────
 *
 * A fatia 1 entregou o VOCABULÁRIO e a tradução de formato. Esta fatia fecha o
 * ciclo, com o contrato que a própria OLX publica em
 * `developers.olx.com.br/chat/`:
 *
 *   1. entrada: `POST /autoservice/v1/chat` registra o webhook na conta do
 *      vendedor (feito pela rota de conexão, não por aqui);
 *   2. saída: `POST /autoservice/v1/chat/send` com `{textMessage, messageId,
 *      chatId}` e `Authorization: Bearer <access token>`;
 *   3. credencial: access token OAuth 2.0 com `scope=chat`, cifrado em
 *      `channel_sessions.olx_token_encrypted` e LIDO por `lib/channels/
 *      chat-de-vendedor/credentials.ts`.
 *
 * O que continua de fora, e por quê: o handshake do OAuth é authorization_code
 * com redirect por navegador (`auth.olx.com.br/oauth` + `/oauth/token`), então
 * a obtenção do token é feita pelo integrador cadastrado junto à OLX e o CRM
 * recebe o access token já na mão.
 *
 * ─── O id da mensagem é NOSSO (resposta da OLX na issue #2927, 15/10) ───────
 *
 * O `messageId` do envio é gerado pelo integrador e serve de chave de
 * idempotência. A doc de envio não devolve id nenhum (só status HTTP), então o
 * id que nós geramos é o único que existe: ele volta como `externalId`, vira o
 * `external_id` da nossa linha, e é com ele que o eco (`origin: "seller"`) se
 * reconhece — `unique (organization_id, external_id)` + a limpeza do eco no
 * handler de envio. Que o eco volte com ESTE id ainda é contrato não medido
 * contra a OLX real.
 *
 * ─── A OLX endereça por THREAD, como o intermediado ─────────────────────────
 *
 * Mesmo caso do adapter irmão que fala com um BSP: quem endereça não é o
 * telefone, é um id que a plataforma inventa e entrega pelo webhook (`chatId`).
 * Por isso `send` exige `providerConversationId` — sem ele não há endereço, e
 * falhar alto com o motivo nomeado é melhor que montar uma URL com `undefined`.
 *
 * `resolveRecipient` continua devolvendo telefone/id opaco porque é o que
 * identifica o CONTATO para o resto do sistema (dedup, log, abertura de
 * conversa); ele não é o que endereça este envio.
 */
import { randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

import { canalChatDeVendedorLigado, chatDeVendedorApiBase, resolveTokenChatDeVendedor } from "../chat-de-vendedor/credentials";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

/** Só dígitos. `+55 (31) 99999-8888` → `5531999998888`. */
function toE164Digits(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** O corpo de envio, na forma que a issue #2927 documenta. */
export interface CorpoDeEnvioOlx {
  chatId: string;
  textMessage: string;
  /** Id que NÓS geramos para esta mensagem — a chave de idempotência da OLX. */
  messageId: string;
}

/**
 * `Authorization: Bearer <token>` do acesso do vendedor.
 *
 * Concatenado em vez de template literal porque a formação do cabeçalho é
 * contrato, não texto: o token nunca aparece em log nem em erro daqui.
 */
function cabecalhoDeAutorizacao(token: string): string {
  return "Bearer " + token;
}

/**
 * Traduz o envelope para o corpo que a OLX recebe.
 *
 * Pura e exportada de propósito: é o CONTRATO que o teste fixa sem precisar de
 * credencial. `chatId` é a thread (`providerConversationId`); `textMessage` é o
 * texto; `messageId` é o id que geramos para esta mensagem (ver o cabeçalho).
 * Citação não existe neste chat: `replyToExternalId` é ignorado, como em todo
 * canal que não sabe citar.
 */
export function corpoDeEnvioOlx(envelope: OutboundEnvelope, messageId: string): CorpoDeEnvioOlx {
  return {
    chatId: envelope.providerConversationId ?? "",
    textMessage: envelope.body ?? "",
    messageId,
  };
}

/**
 * Endpoint de envio, na forma que a doc pública da OLX descreve
 * (`POST /autoservice/v1/chat/send`).
 *
 * Exportada de propósito, como `corpoDeEnvioOlx`: o caminho é contrato, e o
 * teste fixa ele sem precisar de credencial nem de rede.
 */
export function urlDoEnvioOlx(apiBase?: string): string {
  return `${chatDeVendedorApiBase(apiBase)}/autoservice/v1/chat/send`;
}

/**
 * Uma mensagem que chegou pelo chat da OLX, no vocabulário neutro.
 *
 * `origin` diz de quem é a mensagem: `buyer` é o cliente; `seller` é a conta do
 * vendedor — o eco do nosso envio OU o que o vendedor respondeu pelo app e pelo
 * site da OLX, que seguem ativos depois de ligar o webhook. `senderType` é a
 * discriminação que a OLX manda junto — aceito e preservado, sem contrato
 * fechado.
 */
export interface MensagemDeEntradaOlx {
  /** `conversations.provider_conversation_id` — a thread, que endereça este canal. */
  chatId: string;
  /** Deduplicação: o mesmo id nunca vira duas linhas. */
  messageId: string;
  message: string;
  /** `buyer` = cliente; `seller` = a conta do vendedor (eco nosso ou o app da OLX). */
  origin: "buyer" | "seller";
  /** Discriminação que a OLX manda junto do `origin`. Aberta: a doc não a fecha. */
  senderType: string | null;
  name: string | null;
  email: string | null;
  /** Ajuda a casar com um contato que já existe — quando vem. */
  phone: string | null;
  /** ISO-8601 já validado; `null` quando a OLX não mandou um instante legível. */
  messageTimestamp: string | null;
  /** O anúncio — pode entrar como origem do negócio numa fatia seguinte. */
  listId: string | null;
}

export type LeituraDeEntradaOlx =
  | { ok: true; mensagem: MensagemDeEntradaOlx }
  | { ok: false; motivo: "json_invalido" | "contrato_violado"; campos: string[] };

/** Campos sem os quais a mensagem não tem como virar conversa nem deduplicar. */
const OBRIGATORIOS = ["chatId", "messageId", "message", "origin"] as const;

function textoOuNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * O instante da mensagem, normalizado para ISO-8601 — ou `null`.
 *
 * Vai para `messages.sent_at` e para o carimbo da conversa: texto que o
 * Postgres não lê como data faria o INSERT falhar e a OLX reentregar para
 * sempre; texto que ele lê de outro jeito bagunçaria a ordem da conversa.
 * Ilegível vira `null`, e quem grava usa a hora da chegada.
 */
function instanteOuNull(v: unknown): string | null {
  const texto = textoOuNull(v);
  if (texto === null) return null;
  const ms = Date.parse(texto);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Lê o payload de entrada da OLX (um POST por mensagem) no vocabulário neutro.
 *
 * PURA, sem banco: é a fatia verificável do "ingest" — a tradução de formato que
 * a OLX documenta (`chatId`, `message`, `senderType`, `email`, `name`, `phone`,
 * `messageTimestamp`, `messageId`, `origin`, `listId`). Quem grava (a rota de
 * webhook, numa fatia seguinte) usa o resultado disto.
 *
 * Fail-closed no contrato, como o parser do canal intermediado: faltar um campo
 * obrigatório devolve `contrato_violado` com o NOME dos campos (nunca os
 * valores, que são dado de cliente) em vez de seguir com `null` silencioso.
 */
export function lerEntradaOlx(raw: string): LeituraDeEntradaOlx {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, motivo: "json_invalido", campos: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, motivo: "contrato_violado", campos: ["(corpo)"] };
  }
  const o = parsed as Record<string, unknown>;

  const faltando = OBRIGATORIOS.filter((c) => textoOuNull(o[c]) === null);
  const origin = textoOuNull(o.origin);
  if (origin !== null && origin !== "buyer" && origin !== "seller") {
    faltando.push("origin");
  }
  if (faltando.length > 0) {
    return { ok: false, motivo: "contrato_violado", campos: [...new Set(faltando)] };
  }

  return {
    ok: true,
    mensagem: {
      chatId: o.chatId as string,
      messageId: o.messageId as string,
      message: o.message as string,
      origin: origin as "buyer" | "seller",
      senderType: textoOuNull(o.senderType),
      name: textoOuNull(o.name),
      email: textoOuNull(o.email),
      phone: textoOuNull(o.phone),
      messageTimestamp: instanteOuNull(o.messageTimestamp),
      listId: textoOuNull(o.listId),
    },
  };
}

/**
 * `true` quando a mensagem saiu da conta do vendedor — entra como SAÍDA. O eco
 * do nosso próprio envio não vira segunda linha: ele traz o id que geramos, e o
 * `unique (organization_id, external_id)` o recusa.
 */
export function saiuDaConta(mensagem: MensagemDeEntradaOlx): boolean {
  return mensagem.origin === "seller";
}

export const olxAdapter: ChannelAdapter = {
  provider: "olx",

  /**
   * Telefone em dígitos quando existe; senão o id opaco da plataforma.
   *
   * Grupo devolve `null`: este chat não tem grupos (a capability diz `none`), e
   * fingir que um chatId de grupo cabe aqui mandaria a mensagem para o lugar
   * errado. Mesma régua do adapter irmão que endereça por thread.
   */
  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) return null;

    const doIdentity = input.waIdentity?.startsWith("phone:")
      ? input.waIdentity.slice("phone:".length)
      : null;
    const bruto = doIdentity ?? input.phoneNumber ?? null;
    if (bruto) {
      const digitos = toE164Digits(bruto);
      if (digitos.length > 0) return digitos;
    }

    // Sem telefone, devolve o id opaco em vez de `null`: para ESTE canal o
    // telefone não endereça nada, e devolver `null` diria "não há como falar
    // com esta pessoa" — falso, já que acabamos de receber uma mensagem dela.
    const opaco = input.waIdentity?.includes(":")
      ? input.waIdentity.slice(input.waIdentity.indexOf(":") + 1)
      : null;
    return opaco && opaco.length > 0 ? opaco : null;
  },

  /**
   * `true` só com o canal LIGADO na instalação — a metade que este método
   * consegue responder com honestidade.
   *
   * A outra metade (há credencial gravada?) não cabe aqui: `isConfigured` é
   * SÍNCRONO e a credencial vive no banco, cifrada na sessão. Mesmo impasse do
   * canal oficial (#674) e do canal do parceiro: quem fecha a segunda metade é
   * o `send`, que LÊ `olx_token_encrypted` e, sem token, lança
   * `olx_not_configured` — o handler traduz o prefixo para `queued_reason`, o
   * mesmo desfecho de um canal desligado.
   *
   * Com a fatia 1 devolvendo `false` incondicional, um self-hoster que ligasse
   * o canal continuaria sem conseguir ENVIAR: o handler nem chegava ao `send`.
   */
  isConfigured(): boolean {
    return canalChatDeVendedorLigado();
  },

  /**
   * Envia o texto pela API de chat da OLX, com o token da SESSÃO.
   *
   * Três recusas nomeadas, nesta ordem — nunca um `sent` sem id:
   *   1. sem thread (`olx_no_conversation`): requisito estrutural do canal;
   *   2. canal desligado na instalação (`olx_not_configured`);
   *   3. sem credencial gravada (`olx_not_configured`).
   *
   * A resposta de sucesso da OLX é só um status (200 = enviado; a doc pública
   * não descreve corpo), então `externalId` é o id que geramos e mandamos.
   */
  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (!envelope.providerConversationId) {
      throw new Error(
        "olx_no_conversation: envio exige a thread do provider (chatId); " +
          "ela chega no webhook do chat.",
      );
    }
    if (!canalChatDeVendedorLigado()) {
      throw new Error(
        "olx_not_configured: o canal está desligado nesta instalação (OLX_ENABLED).",
      );
    }
    const creds = await resolveTokenChatDeVendedor(createAdminClient(), {
      organizationId: envelope.organizationId,
      sellerId: envelope.sessionRef,
    });
    if (!creds) {
      throw new Error(
        "olx_not_configured: nenhuma credencial OAuth gravada para esta sessão " +
          "(channel_sessions.olx_token_encrypted).",
      );
    }

    await envelope.beforeSend?.();

    const messageId = randomUUID();
    let r: Response;
    try {
      r = await fetch(urlDoEnvioOlx(), {
        method: "POST",
        headers: {
          Authorization: cabecalhoDeAutorizacao(creds.token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(corpoDeEnvioOlx(envelope, messageId)),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      const detalhe = err instanceof Error ? err.message : "erro_desconhecido";
      throw new Error(`olx_error: não foi possível falar com a OLX (${detalhe.slice(0, 200)})`);
    }

    if (!r.ok) {
      // 401 = token inválido/expirado; 400 = body inválido ou conta sem
      // integração; 500 = erro interno deles. O status entra no código para o
      // operador saber procurar do lado de lá.
      const corpo = (await r.text().catch(() => "")).slice(0, 200);
      throw new Error(`olx_${r.status}: ${corpo || "a OLX recusou o envio"}`);
    }

    return { externalId: messageId };
  },

  /**
   * Não há endpoint de saúde documentado — e `reachable: false` é o certo:
   * não deu para perguntar, o que é diferente de "o canal está caído". O cron
   * de saúde NÃO pula quem implementa isto (ao contrário de quem não tem o
   * método), então esta resposta impede que a sessão fique muda na Central.
   *
   * Canal desligado responde a MESMA coisa de canal ligado sem token, e não é
   * atalho preguiçoso: desligado também não tem credencial usável para a
   * sessão, e é essa a pergunta que este método responde. O motivo de o canal
   * estar assim (`OLX_ENABLED` desligado) está nomeado no `send`, que é onde o
   * operador vai ver o envio parar.
   */
  async checkHealth(
    input: ChannelTenantScope & { sessionRef: string },
  ): Promise<ChannelHealth> {
    if (!canalChatDeVendedorLigado()) {
      return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };
    }
    const creds = await resolveTokenChatDeVendedor(createAdminClient(), {
      organizationId: input.organizationId,
      sellerId: input.sessionRef,
    });
    if (!creds) return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };
    return { reachable: false, status: null, detail: "sem_endpoint_de_saude_documentado" };
  },

  codes: {
    notConfigured: "olx_not_configured",
    sendFailed: "olx_error",
    unknownError: "olx_unknown",
  },
};
