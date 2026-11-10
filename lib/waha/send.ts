/**
 * Thin WAHA send helper exposed for the agent runtime (S-13.08).
 *
 * The runtime uses `sendMessageHandler` for the production path (handles WAHA
 * dispatch + outbound message row + ack + retries), so this module is a small
 * convenience for direct callers (tests, smoke checks). Returns null when
 * WAHA env is not configured — callers must treat that as a noop, not error.
 *
 * Vive aqui também `marcarConversaComoLida` (o visto azul, issue #2981), que é
 * a exceção à regra acima: ela É chamada pela produção, pelo adapter do canal
 * por QR (`lib/channels/adapters/waha.ts`), logo depois do transporte aceitar a
 * resposta.
 */
import { logger } from "@/lib/logger";

import { getWahaClient } from "./client";

export interface SendWahaInput {
  sessionName: string;
  chatId: string;
  text: string;
}

/** O que o visto azul precisa saber: por qual número falar e com quem. */
export interface MarcarConversaComoLidaInput {
  /**
   * Só para o LOG. `sessionName` e `chatId` NÃO entram nele: os dois carregam
   * telefone numa instalação real, e o cabeçalho de `lib/logger.ts` proíbe
   * telefone em log. A organização basta para quem for agir sobre a falha.
   */
  organizationId: string;
  sessionName: string;
  chatId: string;
}

export interface ResolveWahaChatIdInput {
  isGroup: boolean;
  groupChatId: string | null;
  phoneNumber: string | null | undefined;
  /** `contacts.wa_identity` (migration 0027): 'phone:+E164' | 'lid:<digits>' | null. */
  waIdentity: string | null | undefined;
  /**
   * `contacts.wa_lid` (migration 0122): só os dígitos do Linked ID, ou null.
   *
   * Existe separada de `waIdentity` por uma razão que custou uma correção
   * errada: `wa_identity` é GERADA com o telefone na frente, então o contato
   * @lid que ganha número passa a valer `phone:+55…` e o teste
   * `waIdentity.startsWith("lid:")` fica FALSO — exatamente para quem a regra
   * precisava valer. Ler o lid daqui é o que faz a ordem abaixo significar algo.
   */
  waLid?: string | null | undefined;
  /**
   * Chat da última mensagem RECEBIDA na conversa, só quando a ficha tem telefone
   * extra (`lib/waha/ultima-recebida.ts`). Vence o `wa_lid`: a pessoa escreveu por
   * este número e é por ele que a resposta volta.
   */
  ultimoRecebidoChatId?: string | null | undefined;
}

/**
 * O endereço WAHA de uma conversa 1:1 ou de grupo.
 *
 * ⚠️ **O `lid:` vem ANTES do telefone, e a ordem é a regra.**
 *
 * Até a migration 0122, contato @lid nunca tinha `phone_number` — o número era
 * descartado na ingestão —, então "telefone primeiro" nunca era exercido para
 * quem chegava por Linked ID. A 0122 passou a gravar o telefone que o WhatsApp
 * sempre mandou (`_data.key.remoteJidAlt`), e com a ordem antiga toda conversa
 * @lid viva mudaria de endereço de `@lid` para `@c.us` no envio seguinte.
 *
 * Trocar o canal de uma conversa que funciona é o pior defeito possível aqui: se
 * o `@c.us` não for endereçável — e para contato em modo privacidade ele
 * frequentemente não é —, paramos de responder o cliente, com a mensagem
 * marcada como enviada. O telefone entra para o CRM (identificar, buscar,
 * ligar, deduplicar); o ENVIO continua indo por onde a conversa veio.
 *
 * Contato sem `lid` (import, formulário, pedido) segue por `@c.us` como sempre.
 */
export function resolveWahaChatId(input: ResolveWahaChatIdInput): string | null {
  if (input.isGroup && input.groupChatId) return input.groupChatId;
  // Ficha com telefone extra: a resposta volta pelo número que a pessoa escreveu
  // (o `wa_lid` é do principal, e responder por ele mandaria ao número errado).
  if (input.ultimoRecebidoChatId) return input.ultimoRecebidoChatId;
  // `wa_lid` primeiro; `wa_identity` só como retaguarda para chamador que ainda
  // não lê a coluna nova (e que, por definição, é de contato sem telefone).
  if (input.waLid) return `${input.waLid}@lid`;
  if (input.waIdentity?.startsWith("lid:")) return `${input.waIdentity.slice(4)}@lid`;
  if (input.phoneNumber) return `${input.phoneNumber.replace(/\D/g, "")}@c.us`;
  return null;
}

export async function sendWAHA(input: SendWahaInput): Promise<unknown | null> {
  const client = getWahaClient();
  if (!client) return null;
  return client.sendMessage(input.sessionName, input.chatId, input.text);
}

/**
 * O visto azul depois de responder (issue #2981).
 *
 * ─── FALHA MACIA, e é o contrato ────────────────────────────────────────────
 *
 * Devolve `false` e LOGA; nunca lança. Quem chama é um envio que já deu certo, e
 * derrubar a resposta — ou o `externalId` dela — por causa de um recibo de
 * leitura seria trocar a mensagem pelo enfeite, a mesma régua que o `reply_to`
 * já segue. Sem env do WAHA é NOOP, como `sendWAHA`.
 *
 * ─── DEPOIS do envio, e a doc do WAHA diz o contrário ───────────────────────
 *
 * A seção `Send Seen` da doc do WAHA manda marcar ANTES de responder e aponta
 * para o guia anti-bloqueio. O que ganhamos marcando antes é uma hipótese do
 * fornecedor que não medimos; o que PERDEMOS é concreto: esta chamada tem o
 * mesmo teto de 15s do `sendText` (`TETO_PADRAO_MS`), e um WAHA que aceita o
 * socket e não responde passaria a segurar toda resposta por até 15s. A
 * resposta é a promessa do produto; o visto é o sinal dela. Ordem declarada.
 *
 * Um enfeite que falha em silêncio é o defeito clássico deste repo, por isso a
 * falha sai em `warn` — com a organização, que é quem consegue agir.
 */
export async function marcarConversaComoLida(
  input: MarcarConversaComoLidaInput,
): Promise<boolean> {
  // Grupo não leva visto: sem `messageIds`, o WAHA marcaria como lidas até 100
  // mensagens de OUTRAS pessoas, e o recibo aparece para todos os participantes.
  // "Respondi, então li" é sobre a conversa com o cliente, não sobre o grupo.
  if (input.chatId.endsWith("@g.us")) return false;
  const client = getWahaClient();
  if (!client) return false;
  try {
    await client.sendSeen(input.sessionName, input.chatId);
    return true;
  } catch (erro) {
    logger.warn("waha: conversa não marcada como lida (a resposta já saiu)", {
      organization_id: input.organizationId,
      detail: erro instanceof Error ? erro.message : "erro_desconhecido",
    });
    return false;
  }
}
