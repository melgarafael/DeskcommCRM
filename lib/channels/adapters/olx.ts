/**
 * Adapter do chat da OLX (issue #2927, fatia 1) — o ESQUELETO verificável.
 *
 * Burro como os irmãos: traduz formato e nada mais. Janela, cap diário e
 * horário vivem na cadeia `before_send` (`docs/doctrine/restricao-de-canal.md`).
 *
 * ─── O que esta fatia entrega, e o que ela NÃO entrega ──────────────────────
 *
 * Entrega o VOCABULÁRIO (o provider existe na união, na matriz de capabilities
 * e nos CHECKs do banco), o adapter registrado no seam e a ENTRADA: duas
 * funções puras que fazem a tradução de formato — uma lê o payload que a OLX
 * empurra, a outra monta o corpo de envio.
 *
 * NÃO entrega o round-trip real. Ficam de fora, por exigirem credencial que esta
 * instalação não tem (client_id, client_secret e conta de vendedor na OLX):
 *
 *   1. O OAuth 2.0 contra `auth.olx.com.br` (`scope=chat`);
 *   2. o registro/desregistro do webhook na conta do vendedor;
 *   3. o envio com resposta 200.
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
 *
 * ─── O contrato do envio NÃO tem fonte pública (medido) ─────────────────────
 *
 * A issue descreve `POST .../chat/send` com `{textMessage, messageId, chatId}` e
 * `Authorization: Bearer <token>` do OAuth da OLX — e registra que a doc pública
 * do chat ainda diverge ("a página de leads diz que a resposta é só pelo
 * portal"). O corpo abaixo reproduz o que a ISSUE documenta, e `corpoDeEnvioOlx`
 * é a fonte única dele. Enquanto o envio não for verificável sem credencial,
 * `send` desiste com `olx_not_configured` em vez de inventar endpoint ou fingir
 * um `sent` sem id.
 */
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
  /** Id da mensagem, quando há uma a que responder (a issue o lista no corpo). */
  messageId?: string;
}

/**
 * Traduz o envelope para o corpo que a OLX recebe.
 *
 * Pura e exportada de propósito: é o CONTRATO que o teste fixa sem precisar de
 * credencial. `chatId` é a thread (`providerConversationId`); `textMessage` é o
 * texto; `messageId` entra só quando há citação (`replyToExternalId`).
 *
 * A issue #2927 lista os TRÊS campos sempre, sem dizer o que `messageId`
 * significa (id próprio? idempotência?). Sem fonte pública, a leitura adotada é
 * a de thread-reply — o id da mensagem a que esta responde — e o campo é OMITIDO
 * quando não há citação, em vez de inventar um id. É contrato PENDENTE.
 */
export function corpoDeEnvioOlx(envelope: OutboundEnvelope): CorpoDeEnvioOlx {
  const corpo: CorpoDeEnvioOlx = {
    chatId: envelope.providerConversationId ?? "",
    textMessage: envelope.body ?? "",
  };
  if (envelope.replyToExternalId) corpo.messageId = envelope.replyToExternalId;
  return corpo;
}

/**
 * Uma mensagem que chegou pelo chat da OLX, no vocabulário neutro.
 *
 * `origin` diz de quem é a mensagem: `buyer` entra (o cliente falou), `seller` é
 * o ECO do que a própria conta enviou (chega pelo webhook do mesmo jeito e não
 * pode virar mensagem nova). `senderType` é a discriminação que a OLX manda
 * junto — aceito e preservado, sem contrato fechado nesta fatia.
 */
export interface MensagemDeEntradaOlx {
  /** `conversations.provider_conversation_id` — a thread, que endereça este canal. */
  chatId: string;
  /** Deduplicação: o mesmo id nunca vira duas linhas. */
  messageId: string;
  message: string;
  /** `buyer` = cliente; `seller` = eco do nosso próprio envio. */
  origin: "buyer" | "seller";
  /** Discriminação que a OLX manda junto do `origin`. Aberta: a doc não a fecha. */
  senderType: string | null;
  name: string | null;
  email: string | null;
  /** Ajuda a casar com um contato que já existe — quando vem. */
  phone: string | null;
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
      messageTimestamp: textoOuNull(o.messageTimestamp),
      listId: textoOuNull(o.listId),
    },
  };
}

/** `true` quando a mensagem é o ECO do que a conta enviou — não entra como nova. */
export function ehEcoDaConta(mensagem: MensagemDeEntradaOlx): boolean {
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
   * `false` — e é a resposta honesta desta fatia.
   *
   * Diferente dos canais cuja credencial vive na SESSÃO (onde `isConfigured`
   * responde `true` porque não consegue consultar o banco com honestidade), a
   * OLX ainda NÃO tem caminho de credencial: o OAuth 2.0 contra `auth.olx.com.br`
   * é trabalho de uma fatia seguinte. Enquanto não houver token, não há envio a
   * ser feito, e dizer `true` faria o handler tentar e falhar por um motivo que
   * este método já sabia.
   */
  isConfigured(): boolean {
    return false;
  },

  /**
   * Não envia nesta fatia. Desiste NOMEANDO o motivo — nunca um `sent` sem id.
   *
   * A thread ainda é conferida primeiro: ela é requisito estrutural do canal
   * (independente de credencial), e falhar por falta dela com o motivo certo
   * evita que, quando o OAuth entrar, o defeito de "thread ausente" apareça
   * disfarçado de "não configurado".
   */
  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (!envelope.providerConversationId) {
      throw new Error(
        "olx_no_conversation: envio exige a thread do provider (chatId); " +
          "ela chega no webhook do chat.",
      );
    }
    // O CORPO do envio está em `corpoDeEnvioOlx` (o contrato que a issue
    // documenta), mas a chamada depende do OAuth da OLX, que esta fatia deixa
    // fora de propósito: sem client_id/client_secret não há token, e inventar
    // endpoint ou resposta seria pior que não enviar.
    throw new Error(
      "olx_not_configured: o envio pela OLX exige credencial OAuth 2.0 " +
        "(auth.olx.com.br, scope=chat), ainda não implementada nesta instalação.",
    );
  },

  /**
   * Sem credencial não há o que sondar — e `reachable: false` é o certo: não
   * deu para perguntar, o que é diferente de "o canal está caído". O cron de
   * saúde NÃO pula quem implementa isto (ao contrário de quem não tem o
   * método), então esta resposta impede que a sessão fique muda na Central.
   */
  async checkHealth(
    _input: ChannelTenantScope & { sessionRef: string },
  ): Promise<ChannelHealth> {
    return { reachable: false, status: null, detail: "sem_credencial_para_a_sessao" };
  },

  codes: {
    notConfigured: "olx_not_configured",
    sendFailed: "olx_error",
    unknownError: "olx_unknown",
  },
};
