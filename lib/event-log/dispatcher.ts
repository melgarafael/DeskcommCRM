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
import { DETALHE_DA_MENSAGEM_EM_QUARENTENA } from "@/lib/channels/quarentena";

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

export interface OpcoesDoDespacho {
  orgParada: boolean;
  soHandlers?: readonly string[];
  /**
   * "Esta mensagem está em quarentena?" (#4026) — opcional de propósito.
   *
   * O dispatcher é registro puro: não tem cliente de banco e não deve passar a
   * ter só por causa de um gate. Quem drena injeta a leitura; quem chama sem
   * ela (testes de registro, caminhos que não têm mensagem no evento) continua
   * com o comportamento de sempre.
   *
   * Quando a resposta é SIM, TODOS os handlers que casariam com o evento são
   * marcados `skipped` com `mensagem_em_quarentena` e entram em `consumed_by` —
   * é o que impede o retry eterno de um evento que nunca vai poder rodar. Este
   * é o ponto único: automação, push, campanha, follow-up e a resposta
   * automática por evento passam todos por aqui, então a marca não precisa ser
   * consultada em vinte arquivos.
   */
  emQuarentena?: (organizationId: string, messageId: string) => Promise<boolean>;
}

/**
 * De qual mensagem este evento fala — `null` quando não fala de uma.
 *
 * `message.received` carrega `payload.message_id` e nem sempre `entity_id`
 * (a recuperação emite com `entity_id` nulo); eventos de outras entidades
 * (`lead.*`, `ai.case_*`) não têm mensagem e não passam pelo gate.
 */
function mensagemDoEvento(row: EventRow): string | null {
  if (row.entity_kind === "message" && row.entity_id) return row.entity_id;
  const doPayload = row.payload?.["message_id"];
  return typeof doPayload === "string" && doPayload.length > 0 ? doPayload : null;
}

/**
 * Match handlers for a single event row, skipping any whose key already lives
 * in `consumed_by`. Returns the per-handler results so the cron driver can
 * decide how to update `consumed_by` / `status` / `attempts`.
 */
export async function dispatchEvent(
  row: EventRow,
  opts: OpcoesDoDespacho,
): Promise<HandlerResult[]> {
  const matches = _handlers.filter(
    (h) =>
      h.events.includes(row.event_type) &&
      !row.consumed_by.includes(h.key) &&
      (!opts.soHandlers || opts.soHandlers.includes(h.key)),
  );
  if (!matches.length) return [];

  // ── QUARENTENA (#4026): a mensagem está segurada ─────────────────────────
  //
  // Um `if`, antes do laço, para o evento inteiro: a mensagem em quarentena não
  // acorda automação, não manda push e não entra na resposta automática. Falha
  // da LEITURA é fail-open (segue o fluxo): perder a resposta de uma conversa
  // legítima por causa de um timeout é pior do que o comportamento de hoje.
  const messageId = mensagemDoEvento(row);
  if (messageId && opts.emQuarentena) {
    try {
      if (await opts.emQuarentena(row.organization_id, messageId)) {
        return matches.map((handler) => ({
          consumer_key: handler.key,
          status: "skipped" as const,
          detail: DETALHE_DA_MENSAGEM_EM_QUARENTENA,
        }));
      }
    } catch (err) {
      logger.warn("[event-log.dispatcher] leitura de quarentena falhou — despachando", {
        event_id: row.id,
        event: row.event_type,
        message_id: messageId,
        error: err instanceof Error ? err.message.slice(0, 160) : "unknown",
      });
    }
  }

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
