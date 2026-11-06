import { chatIdFromWaMessageId } from "@/lib/waha/message-id";

import { canonicalPhoneBR } from "./phone-variants";

/**
 * O telefone do chat de onde veio uma mensagem recebida, lido do id que o WAHA
 * gravou na entrada, ou `null`.
 *
 * O id da mensagem recebida é composto pelo próprio canal
 * (`{fromMe}_{chatId}_{id}`) e é ele que diz de qual chat a mensagem veio.
 *
 * Só chat de número (`@c.us`/`@s.whatsapp.net`). `@lid` não carrega telefone e
 * devolve `null` — quem chama falha fechado. A forma canônica (nono dígito) é a
 * mesma que a ingestão grava na ficha.
 */
export function telefoneDoChatDaMensagem(externalId: string | null | undefined): string | null {
  const chat = externalId ? chatIdFromWaMessageId(externalId) : null;
  if (!chat || !/^\d+@(c\.us|s\.whatsapp\.net)$/.test(chat)) return null;
  return canonicalPhoneBR(`+${chat.slice(0, chat.indexOf("@"))}`);
}
