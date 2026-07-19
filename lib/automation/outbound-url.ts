/**
 * Validação anti-SSRF de URL outbound.
 * ponytail: dois tetos conhecidos —
 *  1) literais IPv6 são bloqueados por INTEIRO (unsafe_url:ipv6_literal), não
 *     só `[::1]`: formas como `[::ffff:127.0.0.1]` (IPv4-mapped) ou `[fc00::1]`
 *     (ULA) contornariam uma regex parcial. Alvo real de webhook (Zapier/n8n/
 *     self-host) usa hostname ou IPv4 público — allowlist de faixas IPv6
 *     públicas só se aparecer demanda real.
 *  2) DNS-rebinding não coberto — hostname público que resolve pra IP privado
 *     no momento do fetch passa o guard; upgrade: resolver DNS e validar o IP
 *     resolvido (e fixá-lo) antes do fetch, se necessário.
 */
const PRIVATE_HOST_RX =
  /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/i;

export function assertSafeOutboundUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("unsafe_url:invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("unsafe_url:scheme");
  }
  if (parsed.protocol === "http:" && process.env.NODE_ENV === "production") {
    throw new Error("unsafe_url:https_required");
  }
  if (parsed.hostname.startsWith("[")) {
    throw new Error("unsafe_url:ipv6_literal");
  }
  if (PRIVATE_HOST_RX.test(parsed.hostname)) {
    throw new Error("unsafe_url:private_host");
  }
}
