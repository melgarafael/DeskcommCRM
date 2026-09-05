/**
 * Quem sabe reportar conversão para qual plataforma.
 *
 * O registro é a fronteira propriamente dita: a feature (`lib/conversoes/`) pede
 * pelo SLUG DA PLATAFORMA que já está gravado na atribuição do contato, e recebe
 * um transporte ou um "não existe". Ela nunca importa `./meta/conversions`.
 *
 * ─── A ausência do Google é DECLARADA, não deduzida do silêncio ─────────────
 *
 * `google_ads` aparece no vocabulário desde a 0164 e não tem transporte aqui —
 * e a razão é anterior a este módulo: não existe extrator de `gclid`. O caminho
 * do Google depende de uma landing page que capture o clique e embuta um código
 * de rastreio na mensagem pré-preenchida, e essa LP não existe. Sem clique
 * capturado não há o que reportar, então implementar o transporte primeiro seria
 * construir a segunda metade de uma ponte que não tem a primeira.
 *
 * Ficar de fora do mapa faria a busca devolver `undefined` e o chamador tratar
 * como bug. Estar no mapa como `null` faz o chamador registrar
 * `plataforma_sem_transporte` no livro-razão — que é o invariante 4 da doutrina
 * de restrição de canal: restrição não aplicável é REGISTRADA, não omitida.
 */
import { transporteMeta } from "./meta/conversions";
import type { PlataformaDeAnuncio, TransporteDeConversao } from "./types";

const TRANSPORTES: Record<PlataformaDeAnuncio, TransporteDeConversao | null> = {
  meta_ads: transporteMeta,
  google_ads: null,
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
