/**
 * Cliente SOAP v2 mínimo para Magento 1 / OpenMage — só o necessário para a
 * Entrega 2 (login + diagnóstico de capacidades). Ver
 * `docs/superpowers/plans/2026-09-06-magento-concierge-carrinho-handoff.md` §4.1.
 *
 * Sem dependência de SOAP: o contrato do Magento 1 é um envelope XML simples
 * (sem WS-Security, sem tipos complexos aninhados nos métodos que usamos aqui),
 * e o repo não tem parser XML instalado — um parser genérico de árvore inteira
 * seria mais código e mais risco do que montar/ler exatamente os campos que
 * `login`/`magentoInfo`/`storeList` devolvem. Provado contra loja real nesta
 * sessão com um script Python equivalente (`.context/magento_probe.py`).
 */
import { logger } from "@/lib/logger";

export class MagentoSoapError extends Error {
  constructor(
    message: string,
    public readonly code: "network_error" | "soap_fault" | "unexpected_response",
  ) {
    super(message);
    this.name = "MagentoSoapError";
  }
}

const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const MAGE_NS = "urn:Magento";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildParamsXml(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join("");
}

const WRAPPER_OVERRIDES: Record<string, string> = {
  login: "loginParam",
  endSession: "endSessionParam",
};

function buildEnvelope(method: string, params: Record<string, string>): string {
  const wrapperTag = WRAPPER_OVERRIDES[method] ?? `${method}RequestParam`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="${SOAP_NS}">` +
    `<SOAP-ENV:Body><ns1:${wrapperTag} xmlns:ns1="${MAGE_NS}">${buildParamsXml(params)}` +
    `</ns1:${wrapperTag}></SOAP-ENV:Body></SOAP-ENV:Envelope>`
  );
}

/** Extrai o texto interno de `<result>...</result>`, tolerando prefixo de namespace (`ns1:result`). */
function extractResultXml(body: string): string | null {
  const match = body.match(/<(?:\w+:)?result[^>]*>([\s\S]*?)<\/(?:\w+:)?result>/);
  return match ? (match[1] ?? "") : null;
}

/** Texto de um elemento simples `<tag>valor</tag>` (primeira ocorrência), com entidades decodificadas. */
function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!match) return null;
  return (match[1] ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * Lista de blocos de item de nível de topo (`<item>`/`<complexObjectArray>`).
 *
 * ⚠️ Rastreia profundidade — não é um regex "não-guloso" ingênuo. O Magento
 * usa a MESMA tag `complexObjectArray` tanto para cada produto quanto para os
 * arrays aninhados dentro dele (ex.: `category_ids` de `catalogProductList`,
 * confirmado contra a loja real: 20.608 produtos, todos com `category_ids`
 * aninhado). Um regex não-guloso `<tag>([\s\S]*?)<\/tag>` fecha no PRIMEIRO
 * fechamento que encontra — que é o da tag interna, não do produto — e
 * devolve fragmentos truncados/vazios para boa parte do catálogo. Medido:
 * sem isto, produtos apareciam com todos os campos vazios.
 */
function extractItems(xml: string): string[] {
  const re = /<(item|complexObjectArray)(?:\s[^>]*)?>|<\/(item|complexObjectArray)>/g;
  const items: string[] = [];
  let depth = 0;
  let start = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    if (match[1] !== undefined) {
      if (depth === 0) start = match.index + match[0].length;
      depth++;
    } else {
      depth--;
      if (depth === 0 && start !== -1) {
        items.push(xml.slice(start, match.index));
        start = -1;
      }
    }
  }
  return items;
}

export interface MagentoConnectionConfig {
  /** URL completa do endpoint SOAP v2, ex.: `https://loja.com/index.php/api/v2_soap/`. */
  endpoint: string;
  apiUser: string;
  apiKey: string;
}

async function soapCall(
  endpoint: string,
  method: string,
  params: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `urn:Magento/${method}`,
      },
      body: buildEnvelope(method, params),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    if (/<faultcode>/.test(text)) {
      const fault = extractTag(text, "faultstring") ?? extractTag(text, "faultcode") ?? "SOAP fault";
      throw new MagentoSoapError(fault, "soap_fault");
    }
    return text;
  } catch (err) {
    if (err instanceof MagentoSoapError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("[magento.soap] chamada falhou", { method, error: msg });
    throw new MagentoSoapError(msg, "network_error");
  } finally {
    clearTimeout(timeout);
  }
}

/** Loga uma sessão SOAP e devolve o `sessionId`. Lança `MagentoSoapError` em falha. */
export async function magentoLogin(
  config: MagentoConnectionConfig,
  timeoutMs = 15_000,
): Promise<string> {
  const body = await soapCall(
    config.endpoint,
    "login",
    { username: config.apiUser, apiKey: config.apiKey },
    timeoutMs,
  );
  const result = extractResultXml(body);
  const sessionId = result?.trim() || null;
  if (!sessionId) {
    throw new MagentoSoapError("resposta de login sem sessionId", "unexpected_response");
  }
  return sessionId;
}

export async function magentoEndSession(
  config: Pick<MagentoConnectionConfig, "endpoint">,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<void> {
  // Best-effort: não é a operação que importa para o diagnóstico, e uma sessão
  // SOAP expira sozinha. Falha aqui nunca deve mascarar o resultado do login.
  await soapCall(config.endpoint, "endSession", { sessionId }, timeoutMs).catch((err) => {
    logger.warn("[magento.soap] endSession falhou (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Loga, roda `fn(sessionId)`, sempre desloga no fim (sucesso ou erro). */
export async function withMagentoSession<T>(
  config: MagentoConnectionConfig,
  fn: (sessionId: string) => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  const sessionId = await magentoLogin(config, timeoutMs);
  try {
    return await fn(sessionId);
  } finally {
    await magentoEndSession(config, sessionId, timeoutMs);
  }
}

export interface MagentoProductListItem {
  productId: string;
  sku: string;
  type: string;
  name: string;
  set: string;
}

/**
 * `catalogProductList` — SEM `page`/`limit` (o plano seção 6.2 é explícito:
 * não inventar paginação que o WSDL não documenta). Devolve o catálogo
 * inteiro na store view pedida; lojas grandes precisam do export do módulo
 * (seção 4.3), não desta chamada.
 */
export async function magentoListProducts(
  config: MagentoConnectionConfig,
  sessionId: string,
  storeView?: string,
  timeoutMs = 30_000,
): Promise<MagentoProductListItem[]> {
  const params: Record<string, string> = { sessionId };
  if (storeView) params.store = storeView;
  const body = await soapCall(config.endpoint, "catalogProductList", params, timeoutMs);
  const result = extractResultXml(body) ?? "";
  return extractItems(result).map((item) => ({
    productId: extractTag(item, "product_id") ?? "",
    sku: extractTag(item, "sku") ?? "",
    type: extractTag(item, "type") ?? "",
    name: extractTag(item, "name") ?? "",
    set: extractTag(item, "set") ?? "",
  }));
}

export interface MagentoProductInfo {
  productId: string;
  sku: string;
  type: string;
  name: string;
  price: string | null;
  status: string | null;
  visibility: string | null;
  urlPath: string | null;
  description: string | null;
  shortDescription: string | null;
}

/** `catalogProductInfo` — detalhes de UM produto (preço, descrição, atributos base). */
export async function magentoGetProduct(
  config: MagentoConnectionConfig,
  sessionId: string,
  productId: string,
  storeView?: string,
  timeoutMs = 15_000,
): Promise<MagentoProductInfo> {
  const params: Record<string, string> = { sessionId, productId };
  if (storeView) params.store = storeView;
  const body = await soapCall(config.endpoint, "catalogProductInfo", params, timeoutMs);
  const result = extractResultXml(body) ?? "";
  return {
    productId: extractTag(result, "product_id") ?? productId,
    sku: extractTag(result, "sku") ?? "",
    type: extractTag(result, "type") ?? "",
    name: extractTag(result, "name") ?? "",
    price: extractTag(result, "price"),
    status: extractTag(result, "status"),
    visibility: extractTag(result, "visibility"),
    urlPath: extractTag(result, "url_path"),
    description: extractTag(result, "description"),
    shortDescription: extractTag(result, "short_description"),
  };
}

export interface MagentoProductImage {
  url: string;
  label: string | null;
  position: string | null;
  types: string[];
}

/**
 * `catalogProductAttributeMediaList` — imagens do produto. `url` já vem
 * absoluta (o Magento monta com o base media da store). Não confundir com
 * `image`/`small_image`/`thumbnail` de `catalogProductInfo`: esses NÃO vêm
 * nessa chamada (confirmado contra a loja real — `catalogProductInfo` não
 * devolve nenhum campo de imagem).
 */
export async function magentoGetProductImages(
  config: MagentoConnectionConfig,
  sessionId: string,
  productId: string,
  storeView?: string,
  timeoutMs = 15_000,
): Promise<MagentoProductImage[]> {
  const params: Record<string, string> = { sessionId, productId };
  if (storeView) params.store = storeView;
  const body = await soapCall(config.endpoint, "catalogProductAttributeMediaList", params, timeoutMs);
  const result = extractResultXml(body) ?? "";
  return extractItems(result)
    .map((item) => {
      const typesBlock = item.match(/<types(?:\s[^>]*)?>([\s\S]*?)<\/types>/)?.[1] ?? "";
      return {
        url: extractTag(item, "url") ?? "",
        label: extractTag(item, "label"),
        position: extractTag(item, "position"),
        types: extractItems(typesBlock),
      };
    })
    .filter((img) => img.url !== "");
}

export interface MagentoStockItem {
  productId: string;
  sku: string;
  qty: string;
  isInStock: boolean;
}

/**
 * XML de `catalogInventoryStockItemList`. Exportado só para o teste travar o
 * formato contra o WSDL: o parâmetro se chama `productIds` (tipo `ArrayOfString`)
 * e cada valor vai em `<complexObjectArray>`. A versão anterior mandava
 * `<products><products>…` — nome errado e aninhado duas vezes — e nunca foi
 * chamada por ninguém, então o erro nunca apareceu.
 */
export function buildStockItemListEnvelope(sessionId: string, productIds: string[]): string {
  const wrapperTag = "catalogInventoryStockItemListRequestParam";
  const itemsXml = productIds
    .map((id) => `<complexObjectArray>${escapeXml(id)}</complexObjectArray>`)
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="${SOAP_NS}">` +
    `<SOAP-ENV:Body><ns1:${wrapperTag} xmlns:ns1="${MAGE_NS}">` +
    `<sessionId>${escapeXml(sessionId)}</sessionId><productIds>${itemsXml}</productIds>` +
    `</ns1:${wrapperTag}></SOAP-ENV:Body></SOAP-ENV:Envelope>`
  );
}

/** `catalogInventoryStockItemList` — estoque em lote, por lista de `product_id` (ou SKU). */
export async function magentoGetStock(
  config: MagentoConnectionConfig,
  sessionId: string,
  productIds: string[],
  timeoutMs = 20_000,
): Promise<MagentoStockItem[]> {
  const envelope = buildStockItemListEnvelope(sessionId, productIds);
  const body = await soapCallRaw(config.endpoint, "catalogInventoryStockItemList", envelope, timeoutMs);
  const result = extractResultXml(body) ?? "";
  return extractItems(result).map((item) => ({
    productId: extractTag(item, "product_id") ?? "",
    sku: extractTag(item, "sku") ?? "",
    qty: extractTag(item, "qty") ?? "0",
    isInStock: extractTag(item, "is_in_stock") === "1",
  }));
}

async function soapCallRaw(
  endpoint: string,
  method: string,
  envelope: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `urn:Magento/${method}` },
      body: envelope,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    if (/<faultcode>/.test(text)) {
      const fault = extractTag(text, "faultstring") ?? extractTag(text, "faultcode") ?? "SOAP fault";
      throw new MagentoSoapError(fault, "soap_fault");
    }
    return text;
  } catch (err) {
    if (err instanceof MagentoSoapError) throw err;
    throw new MagentoSoapError(err instanceof Error ? err.message : String(err), "network_error");
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Carrinho (Entrega 5 do plano de concierge de compras — §4.2/§5.3) ──────
//
// Serialização de array-de-struct em REQUEST (não só em resposta): confirmado
// no WSDL real (`.context/magento-v2.wsdl`, não versionado — artefato de
// pesquisa) que `shoppingCartProductEntityArray` é uma sequência de elementos
// `complexObjectArray` do tipo `shoppingCartProductEntity` — MESMA convenção
// de nome reusado já observada em respostas (`extractItems` acima). Isto NÃO
// foi testado contra a loja real (ao contrário do resto deste arquivo): criar
// quote/mutar carrinho na loja real sem quote sintético é ação com efeito na
// mesma base de produção do cliente, e essa prova fica pra Entrega 7 (ambiente
// de teste), não pra este arquivo. Serialização documentada e coberta por
// teste de unidade contra o XML esperado (`tests/unit/magento-soap-cart.test.ts`).

function buildComplexArrayXml(paramName: string, items: Array<Record<string, string>>): string {
  const inner = items
    .map((item) => `<complexObjectArray>${buildParamsXml(item)}</complexObjectArray>`)
    .join("");
  return `<${paramName}>${inner}</${paramName}>`;
}

export interface MagentoCartLineInput {
  productId: string;
  qty?: number;
}

async function cartProductMutation(
  config: MagentoConnectionConfig,
  method: "shoppingCartProductAdd" | "shoppingCartProductUpdate" | "shoppingCartProductRemove",
  sessionId: string,
  quoteId: string,
  items: MagentoCartLineInput[],
  storeView?: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const wrapperTag = `${method}RequestParam`;
  const productsXml = buildComplexArrayXml(
    "productsData",
    items.map((it) => {
      const row: Record<string, string> = { product_id: it.productId };
      if (it.qty !== undefined) row.qty = String(it.qty);
      return row;
    }),
  );
  const storeXml = storeView ? `<store>${escapeXml(storeView)}</store>` : "";
  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<SOAP-ENV:Envelope xmlns:SOAP-ENV="${SOAP_NS}">` +
    `<SOAP-ENV:Body><ns1:${wrapperTag} xmlns:ns1="${MAGE_NS}">` +
    `<sessionId>${escapeXml(sessionId)}</sessionId><quoteId>${escapeXml(quoteId)}</quoteId>${productsXml}${storeXml}` +
    `</ns1:${wrapperTag}></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  const body = await soapCallRaw(config.endpoint, method, envelope, timeoutMs);
  const result = (extractResultXml(body) ?? "").trim().toLowerCase();
  return result === "1" || result === "true";
}

/** `shoppingCartCreate` — cria um quote visitante vazio. Retorna o `quoteId` (string numérica). */
export async function magentoCreateCart(
  config: MagentoConnectionConfig,
  sessionId: string,
  storeView?: string,
  timeoutMs = 15_000,
): Promise<string> {
  const params: Record<string, string> = { sessionId };
  if (storeView) params.store = storeView;
  const body = await soapCall(config.endpoint, "shoppingCartCreate", params, timeoutMs);
  const quoteId = (extractResultXml(body) ?? "").trim();
  if (!quoteId) {
    throw new MagentoSoapError("resposta de shoppingCartCreate sem quoteId", "unexpected_response");
  }
  return quoteId;
}

/** `shoppingCartProductAdd` — adiciona linhas ao quote. Magento incrementa qty se o produto já está no carrinho. */
export function magentoCartAddItems(
  config: MagentoConnectionConfig,
  sessionId: string,
  quoteId: string,
  items: MagentoCartLineInput[],
  storeView?: string,
  timeoutMs?: number,
): Promise<boolean> {
  return cartProductMutation(config, "shoppingCartProductAdd", sessionId, quoteId, items, storeView, timeoutMs);
}

/** `shoppingCartProductUpdate` — define a quantidade ABSOLUTA da linha (não incrementa; retry-safe). */
export function magentoCartUpdateItems(
  config: MagentoConnectionConfig,
  sessionId: string,
  quoteId: string,
  items: MagentoCartLineInput[],
  storeView?: string,
  timeoutMs?: number,
): Promise<boolean> {
  return cartProductMutation(config, "shoppingCartProductUpdate", sessionId, quoteId, items, storeView, timeoutMs);
}

/** `shoppingCartProductRemove` — remove linhas do quote por `product_id`. */
export function magentoCartRemoveItems(
  config: MagentoConnectionConfig,
  sessionId: string,
  quoteId: string,
  items: MagentoCartLineInput[],
  storeView?: string,
  timeoutMs?: number,
): Promise<boolean> {
  return cartProductMutation(config, "shoppingCartProductRemove", sessionId, quoteId, items, storeView, timeoutMs);
}

export interface MagentoCartItem {
  itemId: string;
  productId: string;
  sku: string;
  name: string;
  qty: number;
  price: number | null;
  rowTotal: number | null;
}

export interface MagentoCartSnapshot {
  quoteId: string;
  isActive: boolean;
  itemsQty: number;
  currency: string | null;
  items: MagentoCartItem[];
}

/** `shoppingCartInfo` — snapshot completo do quote (itens, moeda, status). */
export async function magentoCartInfo(
  config: MagentoConnectionConfig,
  sessionId: string,
  quoteId: string,
  storeView?: string,
  timeoutMs = 15_000,
): Promise<MagentoCartSnapshot> {
  const params: Record<string, string> = { sessionId, quoteId };
  if (storeView) params.store = storeView;
  const body = await soapCall(config.endpoint, "shoppingCartInfo", params, timeoutMs);
  const result = extractResultXml(body) ?? "";
  const itemsBlock = result.match(/<items(?:\s[^>]*)?>([\s\S]*?)<\/items>/)?.[1] ?? "";
  const items = extractItems(itemsBlock).map((item) => ({
    itemId: extractTag(item, "item_id") ?? "",
    productId: extractTag(item, "product_id") ?? "",
    sku: extractTag(item, "sku") ?? "",
    name: extractTag(item, "name") ?? "",
    qty: parseFloat(extractTag(item, "qty") ?? "0") || 0,
    price: extractTag(item, "price") !== null ? parseFloat(extractTag(item, "price")!) : null,
    rowTotal: extractTag(item, "row_total") !== null ? parseFloat(extractTag(item, "row_total")!) : null,
  }));
  return {
    quoteId: extractTag(result, "quote_id") ?? quoteId,
    isActive: extractTag(result, "is_active") === "1",
    itemsQty: parseFloat(extractTag(result, "items_qty") ?? "0") || 0,
    currency: extractTag(result, "quote_currency_code"),
    items,
  };
}

export interface MagentoCartTotal {
  title: string;
  amount: number;
}

/** `shoppingCartTotals` — linhas de total calculadas pelo Magento (Subtotal, Grand Total, ...). */
export async function magentoCartTotals(
  config: MagentoConnectionConfig,
  sessionId: string,
  quoteId: string,
  storeView?: string,
  timeoutMs = 15_000,
): Promise<MagentoCartTotal[]> {
  const params: Record<string, string> = { sessionId, quoteId };
  if (storeView) params.store = storeView;
  const body = await soapCall(config.endpoint, "shoppingCartTotals", params, timeoutMs);
  const result = extractResultXml(body) ?? "";
  return extractItems(result)
    .map((item) => ({
      title: extractTag(item, "title") ?? "",
      amount: parseFloat(extractTag(item, "amount") ?? "0") || 0,
    }))
    .filter((t) => t.title !== "");
}

export interface MagentoCapabilities {
  version: string | null;
  storeViews: Array<{ storeId: string; code: string; websiteId: string }>;
}

/**
 * Diagnóstico mínimo: versão da instalação (`magentoInfo`) + store views
 * (`storeList`). É o que a tela de Integrações mostra depois de conectar —
 * não confirma catálogo/carrinho (isso é a Entrega 3).
 */
export async function magentoCapabilities(
  config: MagentoConnectionConfig,
  timeoutMs = 15_000,
): Promise<MagentoCapabilities> {
  const sessionId = await magentoLogin(config, timeoutMs);
  try {
    const infoBody = await soapCall(config.endpoint, "magentoInfo", { sessionId }, timeoutMs);
    const infoResult = extractResultXml(infoBody) ?? "";
    const version = extractTag(infoResult, "magento_version");

    const storesBody = await soapCall(config.endpoint, "storeList", { sessionId }, timeoutMs);
    const storesResult = extractResultXml(storesBody) ?? "";
    const storeViews = extractItems(storesResult)
      .map((item) => ({
        storeId: extractTag(item, "store_id") ?? "",
        code: extractTag(item, "code") ?? "",
        websiteId: extractTag(item, "website_id") ?? "",
      }))
      .filter((store) => store.storeId !== "");

    return { version, storeViews };
  } finally {
    await magentoEndSession(config, sessionId, timeoutMs);
  }
}
