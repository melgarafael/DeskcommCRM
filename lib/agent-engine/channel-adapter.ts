import type { AgentOperationContext } from '@/lib/ai/agents/operation';
import type { JobClaim } from './queue/claim';
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
  agentOperation?: AgentOperationContext;
  jobClaim?: JobClaim;
  tenantId: string;
  leadId: string | null;
  jobId: string;
  /** posição da mensagem no turno (1..n) — com jobId forma a chave de idempotência */
  seq: number;
  /** referência da conversa no canal (conversation_id do CRM na v1) */
  conversationId: string;
  body: string;
  /**
   * Presente = este envio é um TEMPLATE aprovado, não texto livre.
   *
   * Opcional de propósito: o contrato continua válido para todo canal que só sabe
   * texto, e um adapter que ignore o campo envia o `body` — que já é o template
   * RENDERIZADO (ver `lib/channels/meta/render-template.ts`). Degrada para texto em
   * vez de estourar, e o `body` renderizado é o que os gates de conteúdo avaliaram.
   */
  template?: {
    name: string;
    language: string;
    /** Valor por slot, chaveado por `slotKey` — a mesma chave da tela. */
    values: Record<string, string>;
  };  /**
   * Presente = este envio é uma IMAGEM já guardada no Storage da conversa, e o
   * `body` é a legenda (pode ser vazio). Hoje só a foto do catálogo usa
   * (`agent/fotos-do-produto.ts`). Caminho, nunca URL nem bytes: quem assina a
   * URL curta para o canal é o handler de mensagens, como em toda mídia.
   */
  media?: { storagePath: string; mime: string };
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
  /**
   * Acende o "digitando…" na conversa, antes da 1ª mensagem do turno.
   *
   * OPCIONAL de propósito, por duas razões distintas. A primeira é de canal:
   * nem todo canal tem indicador de presença, e quem chama testa a presença do
   * método em vez de perguntar qual é. A segunda é de compatibilidade: os
   * dublês de `ChannelAdapter` espalhados pelos testes não precisam ganhar um
   * método por causa de um enfeite.
   *
   * Sinalizar é decoração — a espera proporcional que a acompanha
   * (`agent/atraso-humano.ts`) é o que conserta o "responde rápido demais".
   * Um canal sem presença ainda recebe o conserto inteiro menos o indicador.
   */
  signalTyping?(input: { tenantId: string; conversationId: string }): Promise<void>;
  /** o que o canal suporta agora (estático por canal na v1). */
  capabilities(): ChannelCapabilities;
  /** custo por mensagem do canal. */
  costPerMessage(): ChannelCost;
}
