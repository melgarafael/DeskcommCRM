/**
 * Classificação de erro de envio de campanha.
 *
 * - permanent: não retry
 * - transient: retry limitado (5xx claro ANTES do provider aceitar)
 * - uncertain: timeout / ambiguidade — NÃO retry automático (send_uncertain)
 */
export function classifySendError(err: unknown): {
  permanent: boolean;
  uncertain: boolean;
  code: string;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (
    lower.includes("blocked") ||
    lower.includes("opt_out") ||
    lower.includes("invalid") ||
    lower.includes("missing_phone") ||
    lower.includes("anonymized") ||
    lower.includes("forbidden")
  ) {
    return { permanent: true, uncertain: false, code: "permanent", message };
  }

  // Timeout / abort / fetch failed após possível aceitação no WAHA
  if (
    lower.includes("timeout") ||
    lower.includes("abort") ||
    lower.includes("network") ||
    lower.includes("econnreset") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("und_err") ||
    lower.includes("provider_uncertain")
  ) {
    return { permanent: false, uncertain: true, code: "provider_uncertain", message };
  }

  // 5xx / waha_5xx = falha clara do provider ANTES de aceitar (normalmente)
  if (/waha_5\d\d/.test(lower) || lower.includes("waha_502") || lower.includes("waha_503")) {
    return { permanent: false, uncertain: false, code: "transient", message };
  }
  if (lower.includes("waha_4")) {
    // 4xx do WAHA: permanente (payload/sessão)
    return { permanent: true, uncertain: false, code: "permanent", message };
  }

  return { permanent: false, uncertain: false, code: "unknown", message };
}
