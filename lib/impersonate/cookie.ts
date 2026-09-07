/**
 * Impersonate cookie — HMAC-SHA256 signed envelope for platform-admin
 * impersonation sessions (S-11.07).
 *
 * Format: `<base64url(json_payload)>.<base64url(hmac_sha256(payload))>`
 *
 * Trust model:
 *  - Cookie is HttpOnly + Secure + SameSite=Lax with 1h TTL.
 *  - HMAC ensures the cookie cannot be forged by a client who doesn't hold
 *    `IMPERSONATE_COOKIE_SECRET`.
 *  - `verifyImpersonateCookie` uses `timingSafeEqual` to compare HMACs to
 *    avoid leaking info via early-exit string compare.
 *  - Expiry is checked even when HMAC is valid — never trust a stale cookie.
 *
 * The cookie is *additive* to the session: it does NOT change which Supabase
 * user is authenticated. Server code must read this cookie to know the
 * platform admin is acting as a tenant, then thread `actingAsPlatformAdmin`
 * + `organization_id` through downstream audit/queries.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const IMPERSONATE_COOKIE_NAME = "deskcomm-impersonate";
export const IMPERSONATE_TTL_SECONDS = 3600; // 1 hour

export interface ImpersonatePayload {
  /** Referência à sessão; banco é a autoridade, inclusive depois de vencer. */
  sessionId?: string;
  /** Tenant the platform admin is acting as. */
  tenantId: string;
  /** Auth user id of the platform admin. */
  platformAdminId: string;
  /** Unix epoch seconds. Cookie is invalid past this. */
  exp: number;
}

export interface VerifyResult {
  valid: boolean;
  payload?: ImpersonatePayload;
  reason?:
    | "missing_secret"
    | "malformed"
    | "invalid_signature"
    | "expired"
    | "invalid_payload";
}

// ---------------------------------------------------------------------------
// Encoding helpers (base64url, RFC 4648 §5)
// ---------------------------------------------------------------------------

function b64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  // Restore padding + alphabet for Buffer.from('base64')
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function isSecretConfigured(secret: string): boolean {
  return secret.length >= 32;
}

function hmac(payloadB64: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadB64).digest();
}

/**
 * Sign an impersonate payload. Throws if `IMPERSONATE_COOKIE_SECRET` is
 * missing or short — callers MUST pre-check via `isImpersonateSecretReady()`
 * and return 503 to the user when not.
 */
export function signImpersonateCookie(payload: ImpersonatePayload): string {
  const secret = env.IMPERSONATE_COOKIE_SECRET;
  if (!isSecretConfigured(secret)) {
    throw new Error("IMPERSONATE_COOKIE_SECRET missing or <32 chars");
  }
  const json = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(Buffer.from(json, "utf8"));
  const sigB64 = b64urlEncode(hmac(payloadB64, secret));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a cookie token. Never throws — always returns a structured result.
 * Uses `timingSafeEqual` for the HMAC comparison.
 */
export function verifyImpersonateCookie(token: string): VerifyResult {
  const secret = env.IMPERSONATE_COOKIE_SECRET;
  if (!isSecretConfigured(secret)) {
    return { valid: false, reason: "missing_secret" };
  }

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: "malformed" };
  }
  const [payloadB64, sigB64] = parts;

  let providedSig: Buffer;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  const expectedSig = hmac(payloadB64, secret);

  if (
    providedSig.length !== expectedSig.length ||
    !timingSafeEqual(providedSig, expectedSig)
  ) {
    return { valid: false, reason: "invalid_signature" };
  }

  let payload: ImpersonatePayload;
  try {
    const json = b64urlDecode(payloadB64).toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as ImpersonatePayload).tenantId !== "string" ||
      typeof (parsed as ImpersonatePayload).platformAdminId !== "string" ||
      typeof (parsed as ImpersonatePayload).exp !== "number"
    ) {
      return { valid: false, reason: "invalid_payload" };
    }
    payload = parsed as ImpersonatePayload;
  } catch {
    return { valid: false, reason: "invalid_payload" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp <= nowSec) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, payload };
}

/**
 * Boot-safe check used by route handlers to decide whether to issue a 503.
 * Centralised so callers don't reimplement the threshold.
 */
export function isImpersonateSecretReady(): boolean {
  return isSecretConfigured(env.IMPERSONATE_COOKIE_SECRET);
}
