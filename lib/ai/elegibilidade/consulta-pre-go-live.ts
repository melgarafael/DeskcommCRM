import type { SupabaseClient } from "@supabase/supabase-js";

import { contatoPodeTestar, preGoLiveAtivo } from "./pre-go-live";

export type DecisaoPreGoLive =
  | { ativo: false; permite: true; motivo: "fora_do_pre_go_live" }
  | { ativo: true; permite: true; motivo: "numero_de_teste" }
  | { ativo: true; permite: false; motivo: "fora_da_lista_de_teste" };

/**
 * Guarda para caminhos proativos que ainda não têm conversa. O gate normal
 * decide sobre uma conversa; uma automação de primeiro contato precisa fazer
 * esta checagem ANTES de gastar tokens e antes de criar o thread.
 */
export async function decidirPreGoLiveDoCanalViaSupabase(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    contactPhoneNumber: string;
    /**
     * `contacts.social_identity` do destinatário. Opcional: quem não tem (o
     * primeiro contato por telefone) falha fechado na lista social.
     */
    contactSocialIdentity?: string | null;
  },
): Promise<DecisaoPreGoLive> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .maybeSingle();

  if (error) throw new Error(`pre-go-live: leitura do canal falhou — ${error.message}`);
  if (!data) throw new Error("pre-go-live: canal não encontrado");

  const metadata = (data as { metadata: unknown }).metadata;
  if (!preGoLiveAtivo(metadata)) {
    return { ativo: false, permite: true, motivo: "fora_do_pre_go_live" };
  }
  return contatoPodeTestar(
    { telefone: input.contactPhoneNumber, identidadeSocial: input.contactSocialIdentity },
    metadata,
  )
    ? { ativo: true, permite: true, motivo: "numero_de_teste" }
    : { ativo: true, permite: false, motivo: "fora_da_lista_de_teste" };
}
