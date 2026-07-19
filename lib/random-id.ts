/**
 * UUID v4 que funciona FORA de secure context (achado nº 9 do deploy VPS):
 * em `http://IP` (self-host sem TLS) o browser NÃO expõe `crypto.randomUUID`
 * (é restrito a secure context — localhost/https), e o apiClient morria em
 * TypeError ANTES do fetch, derrubando toda tela que fala com a API.
 * `crypto.getRandomValues` existe em QUALQUER contexto; o fallback monta o
 * UUID v4 a partir dele (RFC 4122: version nibble 4, variant 10).
 *
 * Código client-side NUNCA chama `crypto.randomUUID()` cru — sempre este
 * helper (teste-régua em lib/random-id.test.ts).
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
