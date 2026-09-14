/**
 * Verificação da assinatura do webhook do GraphPartner — módulo PURO.
 *
 * O GraphPartner entrega o payload idêntico ao da Meta, mas assina diferente: o header
 * é `x-datafy-signature-256` e o HMAC-SHA256 é do texto `"{timestamp}.{corpo}"`
 * (a Meta assina só o corpo). O secret (`whsec_…`) é configurado no painel do
 * GraphPartner e é POR NÚMERO.
 *
 * A assinatura é OPCIONAL do lado do GraphPartner: os headers só aparecem quando ela
 * está ativada para o número. Quem chama decide o que fazer com a ausência —
 * esta função só responde "confere" para o material que recebeu.
 *
 * Guardar o corpo CRU é obrigatório: o HMAC é sobre os bytes originais, e
 * parsear/reserializar o JSON muda os bytes e a assinatura nunca bate.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A assinatura confere? `false` para qualquer peça ausente ou malformada.
 *
 * Formato aceito: `sha256=<hex>`. Comparação em tempo constante.
 */
export function verifyGraphPartnerSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader || !timestampHeader || !secret) return false;

  const [algo, hex] = signatureHeader.split("=");
  if (algo !== "sha256" || !hex) return false;

  const esperada = createHmac("sha256", secret).update(`${timestampHeader}.${rawBody}`, "utf8").digest("hex");
  const a = Buffer.from(hex, "utf8");
  const b = Buffer.from(esperada, "utf8");
  // Tamanhos diferentes fariam `timingSafeEqual` LANÇAR; comparar antes evita
  // que uma assinatura malformada vire 500 em vez de 401.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
