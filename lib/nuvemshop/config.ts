import { hostAceito } from "@/lib/channels/meta/graph-base";
import { logger } from "@/lib/logger";

/**
 * Nuvemshop integration — static configuration + env-derived credentials.
 *
 * Env vars `NUVEMSHOP_APP_ID`, `NUVEMSHOP_CLIENT_ID`, `NUVEMSHOP_CLIENT_SECRET`
 * are intentionally optional at build time. `getConfig()` returns null when any
 * of them is missing — callers must surface a `not_configured` error and the UI
 * shows a "configure env" card. Once Rafael drops in real keys, the integration
 * activates without code changes.
 */

export const NUVEMSHOP_AUTH_BASE = "https://www.tiendanube.com";
export const NUVEMSHOP_API_BASE = "https://api.tiendanube.com/v1";

/**
 * A base da API desta instalação. `NUVEMSHOP_API_BASE_URL` existe para a prova
 * em tela (receptor local) e homólogo; o portão é o MESMO da Graph da Meta
 * (`hostAceito`): só http/https, barra final aparada e, em produção, `http` só
 * para destino interno. Valor recusado cai no host real e avisa no log.
 */
export function nuvemshopApiBase(): string {
  const bruto = process.env.NUVEMSHOP_API_BASE_URL?.trim();
  if (!bruto) return NUVEMSHOP_API_BASE;
  const aceito = hostAceito(bruto);
  if (!aceito) {
    logger.warn("[nuvemshop.config] NUVEMSHOP_API_BASE_URL recusada; usando o host real", { valor: bruto });
    return NUVEMSHOP_API_BASE;
  }
  return aceito;
}
export const APP_USER_AGENT = "DeskcommCRM (rafael@maudibrasil.com.br)";

export interface NuvemshopConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
}

export function getConfig(): NuvemshopConfig | null {
  const appId = process.env.NUVEMSHOP_APP_ID || "";
  const clientId = process.env.NUVEMSHOP_CLIENT_ID || "";
  const clientSecret = process.env.NUVEMSHOP_CLIENT_SECRET || "";
  if (!appId || !clientId || !clientSecret) return null;
  return { appId, clientId, clientSecret };
}

export function isConfigured(): boolean {
  return getConfig() !== null;
}

/**
 * Mandatory webhook events to subscribe at OAuth callback time. LGPD-specific
 * events (`store/redact`, `customers/redact`, `customers/data_request`) are
 * deferred to EPIC-08.
 */
export const SUBSCRIBED_EVENTS = [
  "order/created",
  "order/updated",
  "order/paid",
  "order/cancelled",
  "product/created",
  "product/updated",
  "product/deleted",
  "app/uninstalled",
] as const;

export type NuvemshopEvent = (typeof SUBSCRIBED_EVENTS)[number];

/**
 * URL-safe slug used in the catch-all webhook route segment. Nuvemshop allows
 * arbitrary URLs per webhook, but we want one route per event for legibility
 * and per-event observability. Slashes -> hyphens.
 */
export function eventToSlug(event: NuvemshopEvent): string {
  return event.replace("/", "-");
}

const SLUG_TO_EVENT: Record<string, NuvemshopEvent> = Object.fromEntries(
  SUBSCRIBED_EVENTS.map((e) => [eventToSlug(e), e]),
);

export function slugToEvent(slug: string): NuvemshopEvent | null {
  return SLUG_TO_EVENT[slug] ?? null;
}
