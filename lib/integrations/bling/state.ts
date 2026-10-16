/**
 * OAuth state token (CSRF defense) para Bling ERP.
 * Formato assinado com HMAC-SHA256 usando INTERNAL_SECRET.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const VALIDADE_DO_ESTADO_BLING_MS = 10 * 60 * 1000; // 10 minutos

export interface EstadoOAuthBling {
  organizationId: string;
  userId: string;
  nonce: string;
  expiraEmMs: number;
}

function obterChaveSegredo(segredoFornecido?: string): string {
  const s = (segredoFornecido || process.env.INTERNAL_SECRET || "").trim();
  if (s.length >= 16) return s;
  return "fallback-bling-oauth-secret-key-32chars";
}

export function emitirEstadoBling(
  organizationId: string,
  userId: string,
  segredo?: string
): string {
  const nonce = randomBytes(16).toString("hex");
  const expiraEmMs = Date.now() + VALIDADE_DO_ESTADO_BLING_MS;
  const payload = `${organizationId}.${userId}.${nonce}.${expiraEmMs}`;
  const sig = createHmac("sha256", obterChaveSegredo(segredo)).update(payload, "utf8").digest("hex");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sig}`;
}

export function verificarEstadoBling(
  token: string | null | undefined,
  segredo?: string
): EstadoOAuthBling | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, sigHex] = parts;
  if (!encodedPayload || !sigHex) return null;

  try {
    const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const expectedSig = createHmac("sha256", obterChaveSegredo(segredo)).update(payload, "utf8").digest("hex");
    if (expectedSig.length !== sigHex.length) return null;
    if (!timingSafeEqual(Buffer.from(expectedSig, "utf8"), Buffer.from(sigHex, "utf8"))) {
      return null;
    }

    const [organizationId, userId, nonce, expStr] = payload.split(".");
    if (!organizationId || !userId || !nonce || !expStr) return null;

    const expiraEmMs = Number(expStr);
    if (!Number.isFinite(expiraEmMs) || Date.now() > expiraEmMs) return null;

    return { organizationId, userId, nonce, expiraEmMs };
  } catch {
    return null;
  }
}
