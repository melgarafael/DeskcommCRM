/**
 * Quem sabe reportar conversão para qual plataforma.
 *
 * O registro é a fronteira propriamente dita: a feature (`lib/conversoes/`) pede
 * pelo SLUG DA PLATAFORMA que já está gravado na atribuição do contato, e recebe
 * um transporte ou um "não existe". Ela nunca importa `./meta/conversions`.
 *
 * ─── O Google Ads agora tem transporte (migration 0263) ─────────────────────
 *
 * `google_ads` ficou sem transporte desde a 0164 porque faltava a metade que
 * captura o clique — sem `gclid` não havia o que reportar. A migration 0261
 * fechou isso (landing page + extrator, `lib/plataformas-de-anuncio/google/atribuicao.ts`)
 * e a 0263 fecha a outra ponta: a credencial (refresh token OAuth + os três
 * identificadores de para onde reportar). `transporteGoogle` (`./google/conversions.ts`)
 * é a segunda metade da ponte.
 *
 * A entrada `null` continua existindo como MECANISMO, não como estado atual:
 * é o que deixa uma plataforma nova entrar no vocabulário (`PlataformaDeAnuncio`)
 * ANTES de ter transporte, sem que a busca vire `undefined` — ver o invariante 4
 * da doutrina de restrição de canal logo abaixo.
 *
 * Ficar de fora do mapa faria a busca devolver `undefined` e o chamador tratar
 * como bug. Estar no mapa como `null` faz o chamador registrar
 * `plataforma_sem_transporte` no livro-razão — que é o invariante 4 da doutrina
 * de restrição de canal: restrição não aplicável é REGISTRADA, não omitida.
 */
import { transporteMeta } from "./meta/conversions";
import { transporteGoogle } from "./google/conversions";
import type { PlataformaDeAnuncio, TransporteDeConversao } from "./types";

const TRANSPORTES: Record<PlataformaDeAnuncio, TransporteDeConversao | null> = {
  meta_ads: transporteMeta,
  google_ads: transporteGoogle,
};

/** O transporte da plataforma, ou `null` quando ela é conhecida e não tem um. */
export function transporteDe(
  plataforma: PlataformaDeAnuncio,
): TransporteDeConversao | null {
  return TRANSPORTES[plataforma] ?? null;
}

/** A plataforma é do vocabulário? Guarda para o que vem do banco em jsonb. */
export function ehPlataformaConhecida(valor: unknown): valor is PlataformaDeAnuncio {
  return typeof valor === "string" && valor in TRANSPORTES;
}

/** Exportado para o teste de matriz: plataforma sem linha aqui reprova. */
export const PLATAFORMAS = Object.keys(TRANSPORTES) as PlataformaDeAnuncio[];
