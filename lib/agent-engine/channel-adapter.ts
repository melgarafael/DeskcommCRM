/**
 * Contrato agnóstico de canal (F2-25; blueprint risco nº 1 + veredito executivo).
 *
 * O RUNTIME e os guardrails falam com o canal de mensagens SÓ por esta interface.
 * Na v1 há um único adapter — WAHA-via-CRM (F2-06/F2-14), em
 * daemon/src/edge/channel/. A migração para a WhatsApp Cloud API troca a
 * IMPLEMENTAÇÃO sem tocar o runtime; o mapa método-a-método, os pré-requisitos de
 * migração e o plano estão em docs/architecture/channel-adapter.md.
 *
 * Tipos PUROS de propósito: sem dependência de pg/runtime (é contrato
 * compartilhável entre daemon e web). A validação de payload acontece nas bordas
 * concretas (o sink do CRM valida o envio; o watchdog valida o status) — não aqui.
 */

/** Uma mensagem de texto a enviar ao lead. Identidade da intenção = (jobId, seq). */
export interface ChannelSendInput {
  tenantId: string;
  leadId: string | null;
  jobId: string;
  /** posição da mensagem no turno (1..n) — com jobId forma a chave de idempotência */
  seq: number;
  /** referência da conversa no canal (conversation_id do CRM na v1) */
  conversationId: string;
  body: string;
}

/**
 * Desfecho do envio de UMA mensagem. Entrega at-least-once, intenção exactly-once:
 * o adapter é idempotente por (jobId, seq) + idempotencyKey. Espelha os estados do
 * sink F2-06 num vocabulário agnóstico de canal.
 */
export type ChannelSendResult =
  /** enviada agora — messageId é o id da mensagem no canal/CRM */
  | { kind: 'sent'; idempotencyKey: string; messageId: string }
  /** replay pós-crash: já estava aceita, nada reenviado */
  | { kind: 'already_sent'; idempotencyKey: string; messageId: string | null }
  /** canal aceitou e SEGURA (sessão fora do ar) — reagendar, nunca dropar */
  | { kind: 'queued'; idempotencyKey: string; messageId: string | null }
  /** veto PERMANENTE de negócio (opt-out/is_blocked, irrevogável — regra dura nº 2) */
  | { kind: 'blocked'; idempotencyKey: string }
  /** o canal registrou a mensagem como falha (retry consome tentativa) */
  | { kind: 'failed'; idempotencyKey: string; messageId: string | null }
  /** transporte/tool indisponível (transiente) — o job re-tenta com a MESMA key */
  | { kind: 'unavailable'; reason: string };

/** Saúde da sessão do número no canal (o "session health" do adapter). */
export interface ChannelSessionHealth {
  /** true só quando o canal pode enviar agora (WAHA: sessão WORKING) */
  healthy: boolean;
  /** status cru do canal, para observabilidade (ex.: WORKING, SCAN_QR_CODE) */
  status: string;
  /** desde quando está neste status (epoch ms), quando conhecido */
  since: number | null;
}

/** O que o canal suporta — determina o que o runtime/guardrails podem assumir. */
export interface ChannelCapabilities {
  /**
   * true = texto livre a qualquer hora (WAHA); false = exige template aprovado
   * fora da janela de serviço (WhatsApp Cloud API).
   */
  freeformAnytime: boolean;
  /** janela de serviço em horas (Cloud API = 24; WAHA não tem janela = null) */
  serviceWindowHours: number | null;
}

/** Custo do canal por mensagem, em centavos de dólar (custo é métrica de 1ª classe). */
export interface ChannelCost {
  /** custo por mensagem enviada; WAHA = 0 (flat/infra); Cloud API = per-message */
  perMessageUsdCents: number;
  /** modelo de cobrança, para a doc/telemetria distinguir os canais */
  model: 'flat' | 'per_message';
}

/**
 * Seam de canal. NADA fora de daemon/src/edge/channel/ instancia uma
 * implementação; o runtime recebe um ChannelAdapter e fala só com ele. O gate
 * mecânico é scripts/lint-channel-adapter.ts (encadeado em `pnpm lint`, no CI).
 */
export interface ChannelAdapter {
  /** id estável do canal, para log/telemetria (ex.: 'waha_via_crm'). */
  readonly channel: string;
  /** envia UMA mensagem pelo sink idempotente do canal. */
  send(input: ChannelSendInput): Promise<ChannelSendResult>;
  /**
   * saúde da sessão do número. Regra dura nº 4: message-plane NUNCA fala com o
   * canal direto — a implementação lê o espelho durável do watchdog (F2-14).
   */
  sessionHealth(channelSessionId: string): Promise<ChannelSessionHealth>;
  /** o que o canal suporta agora (estático por canal na v1). */
  capabilities(): ChannelCapabilities;
  /** custo por mensagem do canal. */
  costPerMessage(): ChannelCost;
}
