import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * "Só fora de produção", medido pelo ÚNICO sinal que distingue bancada de VPS:
 * o endereço do próprio app. `NODE_ENV` não serve, porque o e2e roda
 * `next start`, que é production. Uma VPS nunca tem `NEXT_PUBLIC_APP_URL` em
 * loopback. É o molde de `EXTENSIONS_LOCAL_CATALOG_ORIGIN`.
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function urlDeLoopback(bruto: string): URL | null {
  try {
    const url = new URL(bruto);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

export function resolverBaseDeTeste(bruto: string, urlDoApp: string): string | null {
  const limpo = bruto.trim();
  if (limpo === "") return null;
  const base = urlDeLoopback(limpo);
  if (base === null || urlDeLoopback(urlDoApp) === null) return null;
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
}

let avisado = false;

/** A base de teste em vigor, ou `null` (vale a URL oficial do provedor). */
export function baseDeTesteDaCobranca(): string | null {
  const bruto = env.COBRANCA_API_BASE_URL_TESTE ?? "";
  const base = resolverBaseDeTeste(bruto, env.NEXT_PUBLIC_APP_URL ?? "");
  if (base === null && bruto.trim() !== "" && !avisado) {
    avisado = true;
    logger.warn("cobranca.base_de_teste_ignorada", { motivo: "so_vale_em_loopback_com_o_app_em_loopback" });
  }
  return base;
}
