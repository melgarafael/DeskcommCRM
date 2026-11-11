import type { SupabaseClient } from "@supabase/supabase-js";

import { mesmoTelefoneNaLista } from "@/lib/channels/phone-variants";
import { logger } from "@/lib/logger";
import { chatIdFromWaMessageId } from "@/lib/waha/message-id";

/**
 * Os endereços de conversa individual que a resposta pode usar. Grupo (`@g.us`)
 * e qualquer outra coisa ficam de fora: quem chama cai na regra de sempre.
 */
const SUFIXOS_INDIVIDUAIS = ["@c.us", "@s.whatsapp.net", "@lid"] as const;

/**
 * Só endereço de conversa individual: `<digitos>@c.us`, `<digitos>@s.whatsapp.net`
 * ou `<digitos>@lid`. Devolve null para grupo, para vazio e para lixo.
 *
 * Checagem por sufixo e por dígitos, sem regex com alternância: o valor vem do
 * `external_id` gravado pelo webhook, e uma regex com retrocesso sobre string
 * hostil travaria o envio (o mesmo caso que `telefoneAlternativoDe` já fecha).
 */
export function chatIndividualDaMensagem(chat: string | null): string | null {
  if (!chat) return null;
  const sufixo = SUFIXOS_INDIVIDUAIS.find((s) => chat.endsWith(s));
  if (!sufixo) return null;
  const miolo = chat.slice(0, chat.length - sufixo.length);
  return /^[0-9]+$/.test(miolo) ? chat : null;
}

/**
 * O chat (já validado por `chatIndividualDaMensagem`) é de um número da ficha? Se não
 * for, o envio segue a regra de sempre, a mesma que `reply-address` mostra na tela.
 *
 * `@lid` não traz número para comparar e segue valendo: é o endereço que o WhatsApp deu.
 */
export function chatSegueNaFicha(
  chat: string,
  numerosDaFicha: ReadonlyArray<string | null | undefined>,
): boolean {
  if (chat.endsWith("@lid")) return true;
  return mesmoTelefoneNaLista(numerosDaFicha, `+${chat.slice(0, chat.indexOf("@"))}`) !== undefined;
}

/**
 * O chat da última mensagem recebida na conversa — só quando a ficha tem telefone
 * extra. Ficha sem extra devolve null SEM olhar as mensagens: quem não tem telefone
 * extra continua exatamente como antes.
 *
 * Por que a última RECEBIDA e não o principal: a pessoa escreve pelo número que
 * quer usar; a resposta tem de voltar pelo mesmo número, senão cai no principal da
 * ficha, que pode não ser o que ela usa nesta conversa. O endereço já está no
 * `external_id` do recebido (`chatIdFromWaMessageId`); nada novo é gravado.
 *
 * Número que saiu da ficha também devolve null (`chatSegueNaFicha`).
 *
 * Qualquer erro vira `null` com `warn`: o envio não pode cair por causa desta
 * leitura, e a regra de sempre é o recuo seguro. Vale também para a leitura do
 * principal: endereço não conferido não é usado.
 */
export async function chatIdDaUltimaRecebida(
  admin: SupabaseClient,
  args: { organizationId: string; conversationId: string; contactId: string | null },
): Promise<string | null> {
  if (!args.contactId) return null;
  try {
    const { data: extras, error: erroExtras } = await admin
      .from("contact_phones")
      .select("phone_number")
      .eq("organization_id", args.organizationId)
      .eq("contact_id", args.contactId);
    if (erroExtras) throw erroExtras;
    if (!extras || extras.length === 0) return null;

    const { data: recebidas, error: erroMensagens } = await admin
      .from("messages")
      .select("external_id")
      .eq("organization_id", args.organizationId)
      .eq("conversation_id", args.conversationId)
      .eq("direction", "inbound")
      .not("external_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (erroMensagens) throw erroMensagens;

    const externalId = (recebidas?.[0] as { external_id?: unknown } | undefined)?.external_id;
    if (typeof externalId !== "string") return null;
    const chat = chatIndividualDaMensagem(chatIdFromWaMessageId(externalId));
    if (!chat) return null;
    if (chatSegueNaFicha(chat, extras.map((e) => e.phone_number))) return chat;

    // Só quem não bateu com um extra paga a leitura do principal.
    const { data: ficha, error: erroFicha } = await admin
      .from("contacts")
      .select("phone_number")
      .eq("organization_id", args.organizationId)
      .eq("id", args.contactId)
      .maybeSingle();
    if (erroFicha) throw erroFicha;
    return chatSegueNaFicha(chat, [ficha?.phone_number]) ? chat : null;
  } catch (erro) {
    // Só a organização no log: o chat e o contato carregam telefone.
    logger.warn("waha: endereço da última mensagem recebida indisponível; segue pela regra de hoje", {
      organization_id: args.organizationId,
      detail: erro instanceof Error ? erro.message : "erro_desconhecido",
    });
    return null;
  }
}
