/**
 * Adapter WAHA-via-CRM (F2-25) — o ÚNICO ChannelAdapter da v1. ENVOLVE (não
 * reescreve) o sink idempotente F2-06 (send-message.ts) e o espelho de saúde do
 * watchdog F2-14 (session-watchdog.ts). É o único ponto do daemon que fala com a
 * borda concreta do canal; o runtime/guardrails só enxergam a interface
 * ChannelAdapter (gate: scripts/lint-channel-adapter.ts).
 *
 * A migração para a WhatsApp Cloud API cria um novo adapter aqui e troca o
 * registro — o runtime não muda (prova: daemon/test/channel-adapter.test.ts). O
 * mapa método-a-método e os pré-requisitos estão em
 * docs/architecture/channel-adapter.md.
 */
import type pg from 'pg';

import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelCost,
  ChannelSendInput,
  ChannelSendResult,
  ChannelSessionHealth,
} from '../../channel-adapter';

import { CrmTransportError, type CrmEdgeConfig } from '../crm/mcp-client';
import { sendTurnMessage, SendToolError } from '../crm/send-message';
import { SESSION_HEALTHY_STATUS } from '../crm/session-watchdog';

/** id do canal da v1 — o único adapter (WAHA através do sink do CRM). */
export const WAHA_VIA_CRM_CHANNEL = 'waha_via_crm';

export class WahaChannelAdapter implements ChannelAdapter {
  readonly channel = WAHA_VIA_CRM_CHANNEL;
  // Campos declarados + atribuídos no corpo (não parameter properties): o daemon
  // roda em `node --experimental-strip-types` (strip-only), que não transforma.
  private readonly db: pg.Pool;
  private readonly crmCfg: CrmEdgeConfig;

  constructor(db: pg.Pool, crmCfg: CrmEdgeConfig) {
    this.db = db;
    this.crmCfg = crmCfg;
  }

  async send(input: ChannelSendInput): Promise<ChannelSendResult> {
    try {
      const outcome = await sendTurnMessage(this.db, this.crmCfg, input);
      switch (outcome.kind) {
        case 'sent':
          return { kind: 'sent', idempotencyKey: outcome.idempotencyKey, messageId: outcome.crmMessageId };
        case 'already_sent':
          return { kind: 'already_sent', idempotencyKey: outcome.idempotencyKey, messageId: outcome.crmMessageId };
        case 'queued':
          return { kind: 'queued', idempotencyKey: outcome.idempotencyKey, messageId: outcome.crmMessageId };
        case 'blocked':
          return { kind: 'blocked', idempotencyKey: outcome.idempotencyKey };
        case 'failed':
          return { kind: 'failed', idempotencyKey: outcome.idempotencyKey, messageId: outcome.crmMessageId };
      }
    } catch (err) {
      // Transporte/tool do CRM é transiente por contrato do sink (o ledger fica
      // 'requested' e o replay com a MESMA key dedupa — F2-06) → vira
      // 'unavailable', nunca exceção pro runtime. O reason não carrega PII (é só
      // o nome da classe de erro). Erro de PROGRAMAÇÃO propaga (bug, não retry).
      if (err instanceof CrmTransportError || err instanceof SendToolError) {
        return { kind: 'unavailable', reason: err.name };
      }
      throw err;
    }
  }

  async sessionHealth(channelSessionId: string): Promise<ChannelSessionHealth> {
    // Regra dura nº 4: message-plane NUNCA fala com WAHA — lê o espelho durável
    // que o watchdog (F2-14) mantém a partir do CRM. channel_session_id é um UUID
    // do CRM, globalmente único; sem linha no espelho = ainda não observada.
    const { rows } = await this.db.query<{ status: string; changed_at: string | null }>(
      `select status, status_changed_at::text as changed_at
       from channel_session_health where channel_session_id = $1`,
      [channelSessionId],
    );
    const row = rows[0];
    if (row === undefined) {
      return { healthy: false, status: 'unknown', since: null };
    }
    return {
      healthy: row.status === SESSION_HEALTHY_STATUS,
      status: row.status,
      since: row.changed_at ? new Date(row.changed_at).getTime() : null,
    };
  }

  capabilities(): ChannelCapabilities {
    // WAHA entrega texto livre a qualquer hora — sem janela de serviço nem
    // aprovação de template (contraste com a Cloud API, ver doc).
    return { freeformAnytime: true, serviceWindowHours: null };
  }

  costPerMessage(): ChannelCost {
    // WAHA = custo flat de infra (0 por mensagem). A Cloud API cobra per-message
    // a partir de out/2026 — quando esse adapter existir, o preço é knob de config.
    return { perMessageUsdCents: 0, model: 'flat' };
  }
}
