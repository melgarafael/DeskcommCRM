/**
 * Produto do catálogo da Meta (Graph API) → linha de `catalog_products`.
 *
 * Puxa o máximo que a tabela comporta: todas as fotos (até o teto de 5 do
 * CHECK da 0390), vídeo, link, descrição COM a formatação original, preço
 * "de/por", GTIN, categoria, estoque e peso.
 *
 * ⚠️ A DESCRIÇÃO. A Meta guarda duas: `description`, em texto puro — o HTML é
 * removido SEM pôr nada no lugar, e os parágrafos chegam grudados ("…RosaO
 * Quadriciclo…", medido no catálogo da Turbo Kids em out/2026) — e
 * `rich_text_description`, em HTML. A formatada vence; a pura é a reserva.
 *
 * ⚠️ OS CAMPOS. Pedir à Graph um campo que ela não conhece reprova a página
 * inteira (`#100 Tried accessing nonexisting field (x)`). Por isso os campos
 * extras ficam numa lista à parte, e quem chama tira o campo que a Meta
 * recusar e tenta de novo (`campoRecusadoPelaMeta`).
 */
import { MAXIMO_DE_FOTOS } from "@/lib/catalogo/fotos";
import { precoParaCentavos } from "@/lib/schemas/produtos";

/** O que a importação sempre pediu — não falha em catálogo nenhum. */
export const CAMPOS_BASICOS = [
  "id",
  "retailer_id",
  "name",
  "description",
  "price",
  "currency",
  "image_url",
  "url",
  "availability",
  "brand",
  "condition",
  "visibility",
] as const;

/** O que enriquece o produto; cada um pode ser tirado se a Meta recusar. */
export const CAMPOS_EXTRAS = [
  "rich_text_description",
  "additional_image_urls",
  "images",
  "videos_metadata",
  "sale_price",
  "inventory",
  "gtin",
  "product_type",
  "category",
  "shipping_weight_value",
  "shipping_weight_unit",
] as const;

export interface MetaGraphProduct {
  id: string;
  retailer_id?: string | null;
  name?: string | null;
  description?: string | null;
  rich_text_description?: string | null;
  price?: string | number | null;
  sale_price?: string | number | null;
  currency?: string | null;
  image_url?: string | null;
  additional_image_urls?: unknown;
  images?: unknown;
  videos_metadata?: unknown;
  url?: string | null;
  availability?: string | null;
  inventory?: number | string | null;
  brand?: string | null;
  condition?: string | null;
  gtin?: string | null;
  product_type?: string | null;
  category?: string | null;
  shipping_weight_value?: number | string | null;
  shipping_weight_unit?: string | null;
}

/** A linha que a importação grava — só os campos que vêm da Meta. */
export interface ProdutoDaMeta {
  codigo: string;
  nome: string;
  descricao: string | null;
  preco_cents: number;
  preco_de_cents: number | null;
  moeda: string | null;
  quantidade: number;
  imagem_url: string | null;
  fotos: string[];
  video_url: string | null;
  link_loja: string | null;
  condicao: string | null;
  marca: string | null;
  gtin: string | null;
  categoria: string | null;
  peso_gramas: number | null;
}

const ENTIDADES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  bull: "•",
  hellip: "…",
};

function decodificarEntidades(texto: string): string {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (inteira, nome: string) => {
    if (nome[0] === "#") {
      const codigo = nome[1]?.toLowerCase() === "x" ? parseInt(nome.slice(2), 16) : parseInt(nome.slice(1), 10);
      return Number.isFinite(codigo) && codigo > 0 && codigo < 0x110000 ? String.fromCodePoint(codigo) : inteira;
    }
    return ENTIDADES[nome.toLowerCase()] ?? inteira;
  });
}

/**
 * HTML da descrição → texto do jeito que o WhatsApp mostra: parágrafo e
 * `<br>` viram quebra de linha, item de lista vira "• item", tag some.
 */
export function htmlParaTexto(html: string): string {
  const texto = html
    .replace(/\r\n?/g, "\n")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\/\s*li\s*>/gi, "")
    .replace(/<\/\s*(p|div|ul|ol|h[1-6]|tr|table|section|article|blockquote)\s*>/gi, "\n")
    .replace(/<\s*(p|div|ul|ol|h[1-6]|tr|table|section|article|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodificarEntidades(texto)
    .split("\n")
    .map((linha) => linha.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "199.90 BRL", "R$ 1.234,56", 19990 (já em reais)… → centavos. */
export function precoDaMeta(bruto: string | number | null | undefined): number | null {
  if (bruto === null || bruto === undefined || bruto === "") return null;
  if (typeof bruto === "number") return Number.isFinite(bruto) ? Math.round(bruto * 100) : null;
  const limpo = String(bruto).replace(/[A-Za-z$]/g, "").trim();
  if (!limpo) return null;
  const cents = precoParaCentavos(limpo);
  if (cents !== null) return cents;
  const num = parseFloat(limpo.replace(",", "."));
  return Number.isFinite(num) ? Math.round(num * 100) : null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Lista de URLs a partir de `["u"]`, `[{url}]`, `[{image_url}]` ou `{data:[…]}`. */
function urlsDe(v: unknown, chaves: readonly string[]): string[] {
  const lista = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { data?: unknown }).data) ? (v as { data: unknown[] }).data : [];
  const urls: string[] = [];
  for (const item of lista) {
    if (typeof item === "string") {
      if (/^https?:\/\//i.test(item.trim())) urls.push(item.trim());
      continue;
    }
    if (item && typeof item === "object") {
      for (const chave of chaves) {
        const valor = texto((item as Record<string, unknown>)[chave]);
        if (valor && /^https?:\/\//i.test(valor)) {
          urls.push(valor);
          break;
        }
      }
    }
  }
  return urls;
}

const GRAMAS_POR_UNIDADE: Record<string, number> = { g: 1, kg: 1000, lb: 453.592, oz: 28.3495 };

function pesoEmGramas(valor: unknown, unidade: unknown): number | null {
  const n = typeof valor === "number" ? valor : typeof valor === "string" ? parseFloat(valor.replace(",", ".")) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const fator = GRAMAS_POR_UNIDADE[String(unidade ?? "kg").trim().toLowerCase()];
  return fator ? Math.round(n * fator) : null;
}

/** Junta listas de fotos sem repetir, na ordem, até o teto da tabela. */
export function juntarFotos(...listas: ReadonlyArray<readonly (string | null | undefined)[]>): string[] {
  const vistas: string[] = [];
  for (const lista of listas) {
    for (const foto of lista) {
      const f = foto?.trim();
      if (f && !vistas.includes(f)) vistas.push(f);
    }
  }
  return vistas.slice(0, MAXIMO_DE_FOTOS);
}

export function mapearProdutoDaMeta(item: MetaGraphProduct): ProdutoDaMeta | null {
  const codigo = item.retailer_id?.trim() || item.id;
  if (!codigo) return null;

  const rica = texto(item.rich_text_description);
  const pura = texto(item.description);
  const descricao = rica ? htmlParaTexto(rica) || pura : pura;

  // "de/por": com preço promocional menor, o promocional é o preço e o cheio
  // vira o "de" — o mesmo par que a tela de produto mostra riscado.
  const cheio = precoDaMeta(item.price) ?? 0;
  const promo = precoDaMeta(item.sale_price);
  const emPromocao = promo !== null && promo > 0 && promo < cheio;

  const estoque =
    typeof item.inventory === "number"
      ? item.inventory
      : typeof item.inventory === "string" && /^\d+$/.test(item.inventory.trim())
        ? parseInt(item.inventory, 10)
        : null;
  const disponivel = item.availability ? item.availability.toLowerCase().includes("in stock") : true;

  const principal = texto(item.image_url);
  const fotos = juntarFotos(
    [principal],
    urlsDe(item.additional_image_urls, ["url", "image_url"]),
    urlsDe(item.images, ["url", "image_url", "src"]),
  );
  const [video] = urlsDe(item.videos_metadata, ["video_url", "url"]);

  const moeda = texto(item.currency)?.toUpperCase() ?? null;

  return {
    codigo,
    nome: (item.name || codigo).replace(/\s+/g, " ").trim(),
    descricao,
    preco_cents: emPromocao ? promo : cheio,
    preco_de_cents: emPromocao ? cheio : null,
    moeda: moeda && /^[A-Z]{3}$/.test(moeda) ? moeda : null,
    quantidade: estoque !== null && estoque >= 0 ? estoque : disponivel ? 999 : 0,
    imagem_url: principal ?? fotos[0] ?? null,
    fotos,
    video_url: video ?? null,
    link_loja: texto(item.url),
    condicao: texto(item.condition),
    marca: texto(item.brand),
    gtin: texto(item.gtin),
    categoria: texto(item.product_type) ?? texto(item.category),
    peso_gramas: pesoEmGramas(item.shipping_weight_value, item.shipping_weight_unit),
  };
}

/**
 * O campo que a Meta recusou, a partir da mensagem do erro #100 — ou `null`
 * quando o erro é outro (token, permissão, catálogo inexistente).
 */
export function campoRecusadoPelaMeta(mensagem: string, pedidos: readonly string[]): string | null {
  const m = /nonexisting field \(([a-z0-9_]+)\)/i.exec(mensagem);
  if (!m) return null;
  const campo = m[1]!;
  return pedidos.includes(campo) ? campo : null;
}
