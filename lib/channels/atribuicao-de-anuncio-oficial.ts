/**
 * Extrator de atribuição de anúncio do webhook da API oficial.
 *
 * Mora em `lib/channels/` porque nomeia o provider — é o transporte, não uma
 * feature perguntando identidade (doutrina de restrição de canal, invariante 1).
 * O formato agnóstico e a gravação estão em `lib/leads/atribuicao-de-anuncio.ts`.
 */
import type { AtribuicaoDeAnuncio, Bruto } from "@/lib/leads/atribuicao-de-anuncio";
import { obj, str } from "@/lib/leads/atribuicao-de-anuncio";

/**
 * O objeto `referral` do webhook oficial da Meta (Cloud API, ou um BSP que
 * repassa o payload original). Campos documentados pela plataforma:
 * `source_id`, `source_url`, `source_type` (`"ad"` | `"post"`), `headline`,
 * `body`, `ctwa_clid`.
 *
 * NÃO VERIFICADO contra o BSP real desta instalação (canal `zernio`) — o
 * parser aceita tanto snake_case (forma documentada da Cloud API) quanto
 * camelCase (caso o agregador normalize), e ignora silenciosamente o que não
 * reconhece em vez de lançar. `"post"` é orgânico compartilhado, não anúncio
 * pago — só `"ad"` (ou ausência do campo) conta como atribuição.
 */
export function extrairAtribuicaoMeta(referral: unknown): AtribuicaoDeAnuncio | null {
  const r = obj(referral);
  if (!r) return null;
  const tipo = str(r.source_type) ?? str(r.sourceType);
  if (tipo && tipo !== "ad") return null;

  const sourceId = str(r.ctwa_clid) ?? str(r.ctwaClid);
  // O id do anúncio, SEMPRE, e não só quando o clique falta. Enquanto ele era
  // apenas o degrau de baixo do `??` acima, o payload que trazia os dois — o
  // caso comum — perdia este aqui, e a pergunta "de qual anúncio veio?" ficava
  // sem resposta mesmo com o dado na mão.
  const adId = str(r.source_id) ?? str(r.sourceId);
  const titulo = str(r.headline);
  const sourceUrl = str(r.source_url) ?? str(r.sourceUrl);
  // Sem NENHUM campo que identifique o anúncio, não há o que atribuir — um
  // `referral` vazio (ou só com `body`) não distingue "veio de anúncio" de
  // "o provider mandou um objeto vazio por engano".
  if (!sourceId && !adId && !titulo && !sourceUrl) return null;

  return {
    plataforma: "meta_ads",
    sourceId,
    adId,
    titulo,
    corpo: str(r.body),
    sourceUrl,
    bruto: r,
  };
}
