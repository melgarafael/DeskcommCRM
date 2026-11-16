import type { SupabaseClient } from "@supabase/supabase-js";

import { chatIdDaUltimaRecebida } from "@/lib/waha/ultima-recebida";

/**
 * O canal responde pelo número da última mensagem recebida? Hoje só o WAHA; os
 * outros respondem pelo principal da ficha.
 */
export function respondePelaUltimaRecebida(provider: string | null | undefined): boolean {
  return provider === "waha";
}

/**
 * O endereço da resposta quando a ficha tem telefone extra (Spec 31 §B4): o chat
 * da última mensagem RECEBIDA na conversa, para a resposta voltar pelo número que
 * a pessoa usou. Fica aqui, na fronteira de canal, porque só o WAHA guarda o chat
 * no id da mensagem: Meta e Zernio respondem pelo principal, como hoje, e quem
 * chama não precisa saber qual canal é qual (`pnpm lint:channels`).
 *
 * Devolve `null` — e quem chama segue a regra de sempre — para grupo, para outro
 * canal, para ficha sem extra e para número que saiu da ficha.
 */
export async function enderecoDaUltimaRecebida(
  client: SupabaseClient,
  args: {
    provider: string | null | undefined;
    isGroup: boolean | null | undefined;
    organizationId: string;
    conversationId: string;
    contactId: string | null | undefined;
  },
): Promise<string | null> {
  if (args.provider !== "waha" || args.isGroup) return null;
  return chatIdDaUltimaRecebida(client, {
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    contactId: args.contactId ?? null,
  });
}
