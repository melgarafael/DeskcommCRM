/**
 * O par token↔gclid: criado no clique da landing page, consumido quando a
 * mensagem do WhatsApp chega com o token no texto.
 *
 * Mora aqui — dentro de `lib/plataformas-de-anuncio/google/` — e não em
 * `lib/leads/`, porque o DADO é específico do Google: o `gclid` é o clique de
 * pesquisa paga, e a Meta não precisa dele (o clique-para-WhatsApp dela chega
 * com `ctwa_clid` nativo no `referral`/`contextInfo`). Nomear "google" aqui é
 * legítimo pela mesma razão que `meta/conversions.ts` nomeia "meta" — esta
 * pasta é a segunda fronteira que `lib/plataformas-de-anuncio/types.ts`
 * declara, e dentro dela nomear a plataforma é o ponto, não a exceção.
 *
 * O MECANISMO do token curto (alfabeto, tamanho, retentativa em colisão) não
 * mora mais aqui: ele é o mesmo para a captura de UTM da Meta e subiu para
 * `../captura-de-clique.ts`. O que fica neste arquivo é o que é do Google — o
 * `gclid` e o casamento dele com o contato.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { criarClickRef as criarClickRefNaTabela, type ClickRefCriado } from "../captura-de-clique";

export type { ClickRefCriado };

/** Cria o par token↔gclid. */
export async function criarClickRef(
  admin: SupabaseClient,
  organizationId: string,
  gclid: string,
  queryRaw: Record<string, string>,
): Promise<ClickRefCriado | null> {
  return criarClickRefNaTabela(admin, "google_ads_click_refs", organizationId, {
    gclid,
    query_raw: queryRaw,
  });
}

export interface ClickRefCasado {
  gclid: string;
}

/**
 * Casa um token com um contato — a UPDATE condicional que garante que um
 * clique só é consumido UMA vez. `matched_at is null` no WHERE é a trava:
 * duas mensagens com o mesmo token (replay, ou o mesmo texto reencaminhado)
 * só uma ganha a linha, e a segunda simplesmente não encontra o que atualizar.
 */
export async function casarClickRef(
  admin: SupabaseClient,
  organizationId: string,
  token: string,
  contactId: string,
): Promise<ClickRefCasado | null> {
  const { data, error } = await admin
    .from("google_ads_click_refs")
    .update({ matched_at: new Date().toISOString(), contact_id: contactId })
    .eq("organization_id", organizationId)
    .eq("token", token)
    .is("matched_at", null)
    .select("gclid")
    .maybeSingle();

  if (error) {
    logger.error("[google-ads.captura-de-clique] update de match falhou", {
      organizationId,
      codigo: error.code,
      detalhe: error.message,
    });
    return null;
  }
  if (!data) return null;
  return { gclid: (data as { gclid: string }).gclid };
}
