/**
 * O par ref↔UTM: criado quando alguém clica no botão da landing page (a rota
 * `app/api/v1/anuncios/meta/[org]/route.ts`), consumido quando a mensagem do
 * WhatsApp chega com o ref no texto.
 *
 * Mora aqui, e não em `lib/leads/`, pela mesma razão do irmão do Google: o
 * DADO é o da captura de anúncio, e esta pasta é a segunda fronteira que
 * `lib/plataformas-de-anuncio/types.ts` declara. O MECANISMO do ref (alfabeto,
 * tamanho, retentativa, padrão no texto) é compartilhado em
 * `../captura-de-clique.ts`.
 *
 * Só a metade de CONSUMO vive aqui — a de criação é a genérica, chamada
 * direto pela rota com a tabela como parâmetro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export interface ClickRefDaPaginaCasado {
  /** Só chaves de `CHAVES_DE_UTM`, como a rota as normalizou antes de gravar. */
  utm: Record<string, string>;
}

/**
 * Casa um ref com um contato — a UPDATE condicional que garante que um clique
 * só é consumido UMA vez. `matched_at is null` no WHERE é a trava: o mesmo
 * texto encaminhado adiante não vira atribuição de quem o recebeu, porque a
 * segunda tentativa não encontra o que atualizar.
 *
 * `organization_id` no WHERE é a lição da #236: ref de uma organização nunca
 * pode casar na outra.
 */
export async function casarClickRef(
  admin: SupabaseClient,
  organizationId: string,
  token: string,
  contactId: string,
): Promise<ClickRefDaPaginaCasado | null> {
  const { data, error } = await admin
    .from("meta_ads_click_refs")
    .update({ matched_at: new Date().toISOString(), contact_id: contactId })
    .eq("organization_id", organizationId)
    .eq("token", token)
    .is("matched_at", null)
    .select("utm")
    .maybeSingle();

  if (error) {
    logger.error("[meta.captura-de-clique] update de match falhou", {
      organizationId,
      codigo: error.code,
      detalhe: error.message,
    });
    return null;
  }
  if (!data) return null;

  const utm = (data as { utm: Record<string, string> | null }).utm;
  // A coluna é `not null` com `check (utm <> '{}')`, então isto é defesa de
  // borda, não caso esperado: linha sem UTM não teria o que estampar.
  if (!utm || Object.keys(utm).length === 0) return null;
  return { utm };
}
