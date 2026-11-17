/**
 * Extrator + carimbo da atribuição de Google Ads — a partir do TEXTO da
 * mensagem, não de um payload de provider.
 *
 * Mora aqui, dentro da fronteira de `lib/plataformas-de-anuncio/` (a mesma
 * que `pnpm lint:channels` já allowlista para esta pasta, por causa de
 * `meta/conversions.ts`) — e não em `lib/channels/` nem em `lib/waha/`: os
 * extratores de lá leem a FORMA CRUA que cada transporte usa para o
 * `referral`/`contextInfo` da Meta; este lê o TEXTO já normalizado da
 * mensagem, que é o MESMO em qualquer transporte (API oficial ou QR).
 *
 * Faz DUAS coisas numa função só, ao contrário dos irmãos `extrairAtribuicaoX`
 * de `lib/channels/`/`lib/waha/` (puros, sem I/O): a extração PRECISA de uma
 * consulta ao banco — o token sozinho não diz nada, só o par com o `gclid`
 * guardado no clique (`./captura-de-clique.ts`) diz. Não dá para separar
 * "extrair" de "consultar" como os outros dois fazem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import type { AtribuicaoDeAnuncio } from "@/lib/leads/atribuicao-de-anuncio";
import { logger } from "@/lib/logger";
import { PADRAO_DO_REF } from "../captura-de-clique";
import { casarClickRef } from "./captura-de-clique";

/**
 * O padrão do ref subiu para `../captura-de-clique.ts` quando a captura de UTM
 * da landing page passou a usar o MESMO marcador: um padrão por eixo
 * divergiria no dia em que só um dos dois mudasse de alfabeto.
 */
const PADRAO_DO_TOKEN = PADRAO_DO_REF;

/**
 * A captura não interrompe a entrega da mensagem. Ausência de match é o
 * caminho NORMAL: o mesmo marcador também identifica um recibo de site/Meta.
 * Quem chama tenta o outro tipo de recibo quando este não existe.
 */
export async function extrairEEstamparAtribuicaoGoogle(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  texto: string | null,
): Promise<AtribuicaoDeAnuncio | null> {
  if (!texto) return null;
  const achado = PADRAO_DO_TOKEN.exec(texto);
  if (!achado) return null;

  const token = achado[1];
  // Inalcançável na prática: o grupo de captura é obrigatório no padrão, e
  // `achado` só existe se o padrão inteiro casou. A guarda é só para o
  // `noUncheckedIndexedAccess` do tsconfig — não para um caso real.
  if (!token) return null;
  try {
    const casado = await casarClickRef(admin, organizationId, token, contactId);
    if (!casado) return null;

    const { queryRaw, ...identificadores } = casado;
    const atribuicao: AtribuicaoDeAnuncio = {
      plataforma: "google_ads",
      sourceId: casado.gclid ?? casado.gbraid ?? casado.wbraid ?? null,
      // O ID real atravessa em google_ad_id; ad_id alimenta a hierarquia Meta.
      // O clique continua separado: nunca tratamos gclid como anúncio ou conta.
      adId: null,
      titulo: null,
      corpo: null,
      sourceUrl: null,
      metadadosDaCampanha: queryRaw ?? {},
      bruto: { token, click_identifiers: identificadores },
    };
    await estamparAtribuicaoDoContato(admin, organizationId, contactId, atribuicao);
    // O contato guarda o PRIMEIRO toque; um negócio novo guarda o clique que
    // de fato o originou, mesmo quando o contato já veio de outra campanha.
    return atribuicao;
  } catch (erro) {
    logger.error("Atribuição do clique Google falhou (a mensagem entra assim mesmo)", {
      organizationId, contactId,
      error: erro instanceof Error ? erro.message.slice(0, 160) : "desconhecido",
    });
    return null;
  }
}
