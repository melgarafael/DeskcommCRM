import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";

/**
 * Compara duas strings em tempo constante usando SHA-256 e timingSafeEqual.
 * O hashing prévio garante comprimento fixo (32 bytes), prevenindo tanto
 * timing attacks no conteúdo quanto vazamento do tamanho da string via early return.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Valida a autenticação de chamadas internas de cron.
 * Suporta header `Authorization: Bearer <secret>` e fallback para `x-cron-secret: <secret>`.
 * Compara em tempo constante contra `INTERNAL_CRON_SECRET` e `INTERNAL_SECRET`.
 *
 * Fail-closed: se nenhum secret estiver configurado no ambiente ou nenhum token for fornecido,
 * recusa imediatamente com false.
 */
export function autorizaCron(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const headerSecret = req.headers.get("x-cron-secret")?.trim() ?? "";
  const provided = bearer || headerSecret;

  if (!provided) {
    return false;
  }

  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );

  if (accepted.length === 0) {
    return false;
  }

  return accepted.some((secret) => timingSafeStringEqual(provided, secret));
}
