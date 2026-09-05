/**
 * Ler de qual anúncio o contato veio — o outro lado da 0164.
 *
 * A 0164 (`lib/leads/atribuicao-de-anuncio.ts`) ESTAMPA a atribuição no contato,
 * com guarda de primeiro toque e merge atômico no banco. Este arquivo é o
 * primeiro consumidor dela: até aqui o dado era só de escrita.
 *
 * Não reaproveito o tipo `AtribuicaoDeAnuncio` daquele módulo de propósito. Ele
 * é o formato de ESCRITA e carrega `bruto` — o payload inteiro de onde o dado
 * saiu, que existe para ser prova e pode ter qualquer tamanho. Quem vai enviar
 * precisa de três campos, e arrastar o payload cru para dentro do caminho de
 * envio só criaria chance de ele vazar para um log ou para o fio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehPlataformaConhecida } from "@/lib/plataformas-de-anuncio/registry";
import type { PlataformaDeAnuncio } from "@/lib/plataformas-de-anuncio/types";

export interface AtribuicaoParaEnvio {
  plataforma: PlataformaDeAnuncio;
  /** `ad_source_id` — o `ctwa_clid`, o clique que abriu a conversa. */
  cliqueDeOrigem: string;
  telefone: string | null;
}

export type LeituraDeAtribuicao =
  | { temAtribuicao: true; atribuicao: AtribuicaoParaEnvio }
  | { temAtribuicao: false; motivo: "sem_contato" | "sem_atribuicao" | "plataforma_desconhecida" };

/**
 * ⚠️ FILTRA `organization_id` MESMO TENDO O ID DO CONTATO. O chamador é um
 * worker com client service-role, que bypassa RLS: um `contact_id` de outra
 * organização (por dado corrompido ou por bug de quem monta o evento) leria o
 * telefone e o clique de um terceiro e reportaria a venda na conta de anúncios
 * errada. O mesmo padrão de `encerraDemanda`, e pelo mesmo motivo.
 */
export async function lerAtribuicao(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string | null,
): Promise<LeituraDeAtribuicao> {
  if (!contactId) return { temAtribuicao: false, motivo: "sem_contato" };

  const { data } = await admin
    .from("contacts")
    .select("phone_number, source_metadata")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!data) return { temAtribuicao: false, motivo: "sem_contato" };

  const linha = data as { phone_number: string | null; source_metadata: unknown };
  const meta =
    linha.source_metadata && typeof linha.source_metadata === "object"
      ? (linha.source_metadata as Record<string, unknown>)
      : {};

  const clique = typeof meta.ad_source_id === "string" ? meta.ad_source_id.trim() : "";
  // Sem o clique não há atribuição utilizável: é ele que liga a venda ao anúncio.
  // Ter `ad_platform` sem `ad_source_id` acontece quando o payload trouxe o
  // referral sem o identificador — a 0164 grava os dois como vieram.
  if (!clique) return { temAtribuicao: false, motivo: "sem_atribuicao" };

  // Plataforma que não está no vocabulário significa dado gravado por uma versão
  // futura (ou corrompido). Recusar explicitamente é melhor que assumir a Meta e
  // reportar a venda na conta errada.
  if (!ehPlataformaConhecida(meta.ad_platform)) {
    return { temAtribuicao: false, motivo: "plataforma_desconhecida" };
  }

  return {
    temAtribuicao: true,
    atribuicao: {
      plataforma: meta.ad_platform,
      cliqueDeOrigem: clique,
      // Só dígitos: a plataforma exige E.164 sem `+` nem separadores ANTES do
      // hash. Normalizar depois do hash seria tarde — o hash já estaria errado.
      telefone: linha.phone_number ? linha.phone_number.replace(/\D/g, "") || null : null,
    },
  };
}
