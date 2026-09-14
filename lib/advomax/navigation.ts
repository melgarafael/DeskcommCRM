const DEFAULT_ADVOMAX_URL = "https://advomax.com.br";

/**
 * Destinos externos do CRM passam por uma allowlist pequena. Isso evita que um
 * código vindo de uma mensagem, query string ou integração vire redirecionamento
 * aberto.
 */
export function advomaxAppUrl(path: "/home" | "/pessoas" | "/clientes" | "/documentos" = "/home"): string {
  const configured = process.env.NEXT_PUBLIC_ADVOMAX_APP_URL?.trim() || DEFAULT_ADVOMAX_URL;
  let base: URL;
  try {
    base = new URL(configured);
  } catch {
    base = new URL(DEFAULT_ADVOMAX_URL);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") base = new URL(DEFAULT_ADVOMAX_URL);
  return new URL(path, base).toString();
}

export function advomaxProcessUrl(codigo: number): string {
  if (!Number.isSafeInteger(codigo) || codigo <= 0) return advomaxAppUrl("/home");
  const base = advomaxAppUrl("/home");
  return new URL(`/fichaProcesso/${codigo}`, base).toString();
}
