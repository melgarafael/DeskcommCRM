/**
 * event_log dispatcher — registry of consumers for domain events.
 *
 * Pattern: each handler declares the event types it consumes. The dispatcher
 * receives an `EventRow` (one row from `public.event_log`) and routes it to
 * every handler whose key has not yet been recorded in `consumed_by`.
 *
 * The actual *cron driver* that drains `event_log` (selects rows where
 * `status='pending'` AND `next_attempt_at <= now()`) is intentionally NOT in
 * this file — that lives in `app/api/v1/cron/event-log-drain/route.ts`
 * (created later in this epic). This module only owns the registry and the
 * single-row dispatch contract.
 */

import { logger } from "@/lib/logger";

export interface EventRow {
  id: string;
  organization_id: string;
  event_type: string;
  entity_kind: string;
  entity_id: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  consumed_by: string[];
  attempts: number;
  /**
   * Quando o evento foi EMITIDO — não quando foi lido.
   *
   * ⚠️ OPCIONAL DE PROPÓSITO, e a razão é o raio: 26 arquivos constroem um
   * `EventRow`, a maioria fixtures de teste de outras features. Torná-lo
   * obrigatório quebraria todas elas por uma necessidade de um consumidor só.
   * O caminho de PRODUÇÃO sempre o traz — `drain.ts` o seleciona.
   *
   * Quem depende dele para DESCARTAR (ex.: teto de idade contra backlog de
   * `pending`) tem de falhar ABERTO quando ele faltar: sem a idade não dá para
   * afirmar que o evento é velho, e descartar na dúvida perderia um evento bom.
   */
  created_at?: string;
}

export interface HandlerResult {
  /** Stable key to push into `event_log.consumed_by`. */
  consumer_key: string;
  status: "ok" | "skipped" | "error" | "retry";
  /** ISO timestamp — obrigatório quando status="retry"; drain reagenda sem contar attempt. */
  retry_at?: string;
  detail?: string;
}

/** `detail` do `skipped` de um handler "pula" numa organização parada. */
export const DETALHE_DA_ORG_PARADA = "org_nao_operante";

export interface EventHandler {
  /** Stable key recorded in `event_log.consumed_by`. */
  key: string;
  /** Event types this handler consumes (`["message.received", "message.sent"]`). */
  events: string[];
  /**
   * O que fazer quando a organização do evento NÃO está operante
   * (`lib/organizacao/operante.ts`). Obrigatório: handler novo sem classificação
   * não compila, e `tests/unit/dispatcher-org-parada.test.ts` guarda a lista.
   *
   *   "roda" — escrita interna, LGPD ou entrada: segue normal.
   *   "pula" — custa dinheiro ou sai para fora: `skipped` com
   *            `org_nao_operante`, vai para `consumed_by` e NÃO volta na
   *            reativação (reativação é sem rajada, spec §1.3).
   */
  naOrgParada: "roda" | "pula";
  handle(row: EventRow): Promise<HandlerResult>;
}

const _handlers: EventHandler[] = [];
const _registeredKeys = new Set<string>();

export function registerHandler(handler: EventHandler): void {
  if (_registeredKeys.has(handler.key)) {
    // Hot-reload friendly — overwrite by removing prior entry.
    const idx = _handlers.findIndex((h) => h.key === handler.key);
    if (idx >= 0) _handlers.splice(idx, 1);
  }
  _handlers.push(handler);
  _registeredKeys.add(handler.key);
}

export function getRegisteredHandlers(): readonly EventHandler[] {
  return _handlers;
}

/**
 * Match handlers for a single event row, skipping any whose key already lives
 * in `consumed_by`. Returns the per-handler results so the cron driver can
 * decide how to update `consumed_by` / `status` / `attempts`.
 */
export async function dispatchEvent(
  row: EventRow,
  opts: { orgParada: boolean },
): Promise<HandlerResult[]> {
  const matches = _handlers.filter(
    (h) => h.events.includes(row.event_type) && !row.consumed_by.includes(h.key),
  );
  if (!matches.length) return [];

  const results: HandlerResult[] = [];
  for (const handler of matches) {
    if (opts.orgParada && handler.naOrgParada === "pula") {
      results.push({ consumer_key: handler.key, status: "skipped", detail: DETALHE_DA_ORG_PARADA });
      continue;
    }
    try {
      const r = await handler.handle(row);
      results.push(r);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("[event-log.dispatcher] handler threw", {
        handler: handler.key,
        event: row.event_type,
        event_id: row.id,
        error: detail,
      });
      results.push({ consumer_key: handler.key, status: "error", detail });
    }
  }
  return results;
}
