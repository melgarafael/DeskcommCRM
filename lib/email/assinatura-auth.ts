import { createHmac, timingSafeEqual } from "node:crypto";

/** Standard Webhooks v1: assina id.timestamp.corpo BRUTO, nunca JSON reserializado.
 * https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 */
export function verificarAssinaturaAuth(
  corpo: string,
  headers: Headers,
  segredo: string,
  agora = Date.now(),
): string | null {
  const id = headers.get("webhook-id") ?? "";
  const timestamp = headers.get("webhook-timestamp") ?? "";
  const assinaturas = headers.get("webhook-signature") ?? "";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || !/^\d{1,12}$/.test(timestamp)) return null;
  if (Math.abs(agora / 1000 - Number(timestamp)) > 300) return null;
  const base64 = segredo.replace(/^v1,whsec_/, "").replace(/^whsec_/, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const chave = Buffer.from(base64, "base64");
  if (chave.length < 24 || chave.length > 64 || chave.toString("base64") !== base64) return null;
  const esperado = createHmac("sha256", chave).update(`${id}.${timestamp}.${corpo}`).digest();
  for (const assinatura of assinaturas.split(" ")) {
    const [versao, valor] = assinatura.split(",");
    if (versao !== "v1" || !valor || !/^[A-Za-z0-9+/]{43}=$/.test(valor)) continue;
    const recebido = Buffer.from(valor, "base64");
    if (recebido.length === esperado.length && timingSafeEqual(recebido, esperado)) return id;
  }
  return null;
}
