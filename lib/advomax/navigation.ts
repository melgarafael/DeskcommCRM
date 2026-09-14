const PUBLIC_ADVOMAX_URL = "https://advomax.com.br";
const LOCAL_ADVOMAX_URL = "http://127.0.0.1:5173";

function fallbackAdvomaxUrl(): string {
  return process.env.NODE_ENV === "production" ? PUBLIC_ADVOMAX_URL : LOCAL_ADVOMAX_URL;
}

function hostLocal(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Destinos externos do CRM passam por uma allowlist pequena. Isso evita que um
 * código vindo de uma mensagem, query string ou integração vire redirecionamento
 * aberto.
 */
export function advomaxAppUrl(path: "/home" | "/pessoas" | "/clientes" | "/documentos" = "/home"): string {
  const fallback = fallbackAdvomaxUrl();
  const configured = process.env.NEXT_PUBLIC_ADVOMAX_APP_URL?.trim() || fallback;
  let base: URL;
  try {
    base = new URL(configured);
  } catch {
    base = new URL(fallback);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") base = new URL(fallback);
  if (process.env.NODE_ENV !== "production" && !hostLocal(base.hostname)) base = new URL(LOCAL_ADVOMAX_URL);
  return new URL(path, base).toString();
}

export function advomaxProcessUrl(codigo: number): string {
  if (!Number.isSafeInteger(codigo) || codigo <= 0) return advomaxAppUrl("/home");
  const base = advomaxAppUrl("/home");
  return new URL(`/fichaProcesso/${codigo}`, base).toString();
}
