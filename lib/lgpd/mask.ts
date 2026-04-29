/**
 * PII masking helpers for LGPD preview endpoints.
 *
 * NEVER expose CPF — omit entirely.
 * Email: a***@dominio.com
 * Phone: (**) ****-${last4}
 */

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const atIdx = email.indexOf("@");
  if (atIdx <= 0) return "***";
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx); // includes @
  const prefix = local[0] ?? "*";
  return `${prefix}***${domain}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  // Strip non-digits to extract last 4
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "(**) ****-****";
  const last4 = digits.slice(-4);
  return `(**) ****-${last4}`;
}
