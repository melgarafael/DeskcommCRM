import {
  CHAVES_DE_METADADOS_GOOGLE,
  normalizarMetadadosGoogle,
} from "@/lib/plataformas-de-anuncio/google/metadados-da-campanha";

/** Escolhas fechadas da ação add_tag; não são caminhos nem expressões. */
export const CAMPOS_DE_ETIQUETA_GOOGLE_ADS = [
  "campaign", "adgroup", "ad", "keyword", "account",
] as const;

export type CampoDeEtiquetaGoogleAds = (typeof CAMPOS_DE_ETIQUETA_GOOGLE_ADS)[number];

export const ROTULOS_DE_ETIQUETA_GOOGLE_ADS: Record<CampoDeEtiquetaGoogleAds, string> = {
  campaign: "Campanha", adgroup: "Grupo de anúncios", ad: "Anúncio", keyword: "Palavra-chave", account: "Conta do Google Ads",
};

const DIMENSOES = {
  campaign: { nome: "utm_campaign", id: "google_campaign_id", rotulo: "campanha" },
  adgroup: { nome: "utm_adset", id: "google_adgroup_id", rotulo: "grupo" },
  ad: { nome: "utm_ad", reserva: "utm_content", id: "google_ad_id", rotulo: "anúncio" },
  keyword: { nome: "utm_term", rotulo: "palavra-chave" },
  account: { id: "google_customer_id", rotulo: "conta" },
} as const;

function objeto(valor: unknown): Record<string, unknown> | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor)
    ? valor as Record<string, unknown>
    : null;
}

/**
 * Só lê a origem já carimbada no negócio. UTM/URL/clique isolado não prova a
 * plataforma e nunca vira etiqueta. A mesma lista segura da captação filtra
 * valores legados; aliases genéricos de ID ficam fora desta leitura.
 */
export function etiquetasGoogleAds(contexto: Record<string, unknown>, campos: unknown): string[] {
  if (!Array.isArray(campos) || campos.length === 0) return [];
  const lead = objeto(contexto.lead);
  const metadata = objeto(lead?.source_metadata);
  if (!metadata || (lead?.source !== "google_ads" && metadata.ad_platform !== "google_ads")) return [];

  const dados = normalizarMetadadosGoogle(Object.fromEntries(
    CHAVES_DE_METADADOS_GOOGLE.map((chave) => [chave, metadata[chave]]),
  ));
  const resultado: string[] = [];
  for (const campo of CAMPOS_DE_ETIQUETA_GOOGLE_ADS) {
    if (!campos.includes(campo)) continue;
    const dimensao = DIMENSOES[campo];
    const nome = ("nome" in dimensao ? dados[dimensao.nome] : undefined)
      ?? ("reserva" in dimensao ? dados[dimensao.reserva] : undefined);
    const id = "id" in dimensao ? dados[dimensao.id] : undefined;
    const prefixo = `Google Ads · ${dimensao.rotulo}: `;
    const valor = nome && id && nome !== id ? `${nome} [${id}]` : (nome ?? id);
    if (!valor) continue;

    const etiqueta = prefixo + valor;
    // O ID diferencia campanhas/grupos/anúncios homônimos. Se o nome não
    // couber nos 60 caracteres nativos, conserva o ID em vez de truncá-lo.
    if (etiqueta.length <= 60) resultado.push(etiqueta);
    else if (id && (prefixo + id).length <= 60) resultado.push(prefixo + id);
  }
  return resultado;
}
