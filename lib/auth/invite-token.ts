/**
 * Stateless HMAC-SHA256 invite token. Self-contained payload, signed and
 * base64url-encoded — no DB row required to issue. Verified at accept time.
 *
 * Format: `<body>.<sig>` where
 *   - body = base64url(JSON({invite_id, email, organization_id, role, exp}))
 *   - sig  = base64url(HMAC_SHA256(secret, body))
 *
 * Secret resolution: INVITE_TOKEN_SECRET → INTERNAL_SECRET → "dev-fallback".
 * Production deployments MUST set one of the first two. Verification uses
 * `timingSafeEqual` to avoid timing oracles.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = (): string =>
  process.env.INVITE_TOKEN_SECRET ?? process.env.INTERNAL_SECRET ?? "dev-fallback";

export interface InvitePayload {
  invite_id: string;
  email: string;
  organization_id: string;
  role: string;
  exp: number; // epoch seconds
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signInviteToken(payload: InvitePayload): string {
  const json = JSON.stringify(payload);
  const body = b64url(Buffer.from(json, "utf8"));
  const sig = b64url(createHmac("sha256", SECRET()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyInviteToken(token: string): InvitePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = b64url(createHmac("sha256", SECRET()).update(body).digest());
  if (sig.length !== expected.length) return null;

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload: InvitePayload;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    payload = JSON.parse(json) as InvitePayload;
  } catch {
    return null;
  }

  if (
    typeof payload.invite_id !== "string" ||
    typeof payload.email !== "string" ||
    typeof payload.organization_id !== "string" ||
    typeof payload.role !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }

  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

export const INVITE_TTL_SECONDS = 60 * 60 * 24; // 24h
