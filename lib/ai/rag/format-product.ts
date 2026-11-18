/**
 * Formats a Nuvemshop product into a plain-text document suitable for RAG embedding.
 *
 * Strips HTML from descriptions and produces a labeled, human-readable template
 * that embeds well for semantic search.
 */

export interface NuvemshopProductVariant {
  price?: string;
  sku?: string;
}

/**
 * A API de produtos da Nuvemshop devolve os textos por idioma da loja
 * (`{ "pt": "...", "es": "..." }`) — o nome E a descrição. A descrição era
 * tipada como texto puro e ia direto para `stripHtml`, que quebrava com
 * `html.replace is not a function` em todo produto: a fonte "Catálogo de
 * produtos" ficava com zero trechos e o agente nunca enxergava a loja.
 */
type TextoPorIdioma = string | Partial<Record<string, string | null>>;

export interface NuvemshopProduct {
  id: string;
  name: TextoPorIdioma;
  description?: TextoPorIdioma | null;
  price?: string;
  sku?: string;
  permalink?: string;
  variants?: NuvemshopProductVariant[];
  categories?: Array<{ name: TextoPorIdioma }>;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Português primeiro; loja só em espanhol ou inglês cai no primeiro idioma
 * preenchido, em vez de sair vazia.
 */
function resolveName(texto: TextoPorIdioma | null | undefined): string {
  if (!texto) return "";
  if (typeof texto === "string") return texto;
  const pt = texto.pt;
  if (typeof pt === "string" && pt.trim()) return pt;
  for (const valor of Object.values(texto)) {
    if (typeof valor === "string" && valor.trim()) return valor;
  }
  return "";
}

/**
 * Converts a Nuvemshop product object into a plain-text RAG document.
 */
export function formatProductForRag(product: NuvemshopProduct): string {
  const name = resolveName(product.name);
  const description = stripHtml(resolveName(product.description));
  const price = product.price ? `R$ ${product.price}` : "N/A";
  const sku = product.sku ?? "N/A";
  const permalink = product.permalink ?? "";

  const variants =
    product.variants && product.variants.length > 0
      ? product.variants
          .map((v) => {
            const parts: string[] = [];
            if (v.price) parts.push(`Preço: R$ ${v.price}`);
            if (v.sku) parts.push(`SKU: ${v.sku}`);
            return parts.join(", ");
          })
          .filter((v) => v.length > 0)
          .join(" | ")
      : "N/A";

  const categories =
    product.categories && product.categories.length > 0
      ? product.categories.map((c) => resolveName(c.name)).join(", ")
      : "N/A";

  const lines: string[] = [
    `Produto: ${name}`,
    `Descrição: ${description || "N/A"}`,
    `Preço: ${price}`,
    `Variantes: ${variants}`,
    `Categorias: ${categories}`,
    `SKU: ${sku}`,
  ];

  if (permalink) {
    lines.push(`Link: ${permalink}`);
  }

  return lines.join("\n");
}
