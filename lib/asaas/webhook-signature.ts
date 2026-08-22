/**
 * Validação do webhook Asaas.
 *
 * Diferente de WAHA (HMAC sobre o corpo), a Asaas usa um TOKEN ESTÁTICO
 * configurado no painel deles, enviado de volta no header `asaas-access-token`
 * em toda chamada. Não é assinatura criptográfica — é comparação de segredo
 * compartilhado, então o cuidado é o mesmo de uma API key: nunca comparar com
 * `===` (vaza timing), sempre `crypto.timingSafeEqual` (padrão já usado pelo
 * HMAC do WAHA em `CLAUDE.md`).
 */
import { timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

export function validarTokenDoWebhookAsaas(headerToken: string | null): boolean {
  const esperado = env.ASAAS_WEBHOOK_TOKEN;
  if (!esperado || !headerToken) return false;

  const a = Buffer.from(headerToken);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
