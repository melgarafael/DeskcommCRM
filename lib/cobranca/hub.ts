import type { SupabaseClient } from "@supabase/supabase-js";

import { lerPainelDaAssinatura, type DadosDoPainel } from "@/lib/cobranca/painel";
import { logger } from "@/lib/logger";
import type { TipoDeSuspensao } from "@/lib/organizacao/operante";

/**
 * O que o hub de conta suspensa mostra (spec da cobrança §9, §7d.5): quem
 * administra uma empresa suspensa POR FALTA DE PAGAMENTO vê como pagar — e
 * volta sozinho ao pagar. Suspensão administrativa segue com o contato de quem
 * opera; quem não administra é mandado a quem administra.
 */
export function oQueOHubMostra(o: {
  administra: boolean;
  tipo: TipoDeSuspensao | null;
  cobrancaLigada: boolean;
  temAssinatura: boolean;
}): "pagamento" | "contato" | "avise_o_admin" {
  if (!o.administra) return "avise_o_admin";
  return o.tipo === "cobranca" && o.cobrancaLigada && o.temAssinatura ? "pagamento" : "contato";
}

/**
 * O painel do hub, ou null quando a leitura falha: o hub é a única tela de uma
 * empresa suspensa, e Sair e os pedidos de LGPD (que têm prazo) moram nela. Sem
 * painel, `oQueOHubMostra` cai para "contato" e não há botão de pagar.
 */
export async function lerPainelDoHub(admin: SupabaseClient, orgId: string): Promise<DadosDoPainel | null> {
  try {
    return await lerPainelDaAssinatura(admin, orgId);
  } catch (e) {
    logger.error("cobranca: painel do hub ilegível; o hub segue sem o botão de pagar", {
      organizationId: orgId,
      erro: e instanceof Error ? e.name : "desconhecido",
    });
    return null;
  }
}
