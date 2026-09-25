/**
 * Assinatura do webhook do Datafy — módulo PURO (recorte do #1130, @vgamkt).
 *
 * O Datafy entrega o payload idêntico ao da Meta, mas assina diferente: o
 * header é `x-datafy-signature-256` (`sha256=<hex>`) e o HMAC-SHA256 é do texto
 * `"{timestamp}.{corpo}"`, com o timestamp em `x-datafy-timestamp` (a Meta
 * assina só o corpo). O segredo (`whsec_…`) nasce no painel do Datafy, por
 * número, quando a assinatura é ativada lá.
 *
 * Do NOSSO lado a assinatura não é opcional: sem o `whsec_` gravado, a entrada
 * recusa tudo. Uma URL secreta sozinha deixaria qualquer um que a visse
 * (log de proxy, print de tela) injetar mensagem forjada na caixa de entrada —
 * a exceção que o canal por QR já pagou.
 *
 * O corpo tem de chegar CRU: o HMAC é sobre os bytes originais, e
 * parsear/reserializar o JSON muda os bytes e a assinatura nunca bate.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** O prefixo que o painel do provedor dá ao segredo de assinatura. */
export const PREFIXO_DO_SEGREDO = "whsec_";

export const HEADER_ASSINATURA = "x-datafy-signature-256";
export const HEADER_TIMESTAMP = "x-datafy-timestamp";

/** A assinatura confere? `false` para qualquer peça ausente ou malformada. */
export function verifyGraphPartnerSignature(
  rawBody: string,
  signatureHeader: string | null,
  timestampHeader: string | null,
  secret: string | null,
): boolean {
  if (!signatureHeader || !timestampHeader || !secret?.startsWith(PREFIXO_DO_SEGREDO)) return false;

  const [algo, hex] = signatureHeader.split("=");
  if (algo !== "sha256" || !hex) return false;

  const esperada = createHmac("sha256", secret)
    .update(`${timestampHeader}.${rawBody}`, "utf8")
    .digest("hex");
  const a = Buffer.from(hex, "utf8");
  const b = Buffer.from(esperada, "utf8");
  // Tamanhos diferentes fariam `timingSafeEqual` LANÇAR; comparar antes evita
  // que uma assinatura malformada vire 500 em vez de 401.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
