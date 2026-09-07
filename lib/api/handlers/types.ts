import type { AgentOperationContext } from "@/lib/ai/agents/operation";
import type { ApprovedReplyContext } from "@/lib/ai/replies/delivery";
import type { MeetingDeliveryContext, MeetingBookingContext } from "@/lib/agenda/meet-delivery";
import type { ProactiveContext } from "@/lib/agenda/efeito";
import type { ServiceOrigin } from "@/lib/atendimento/origem";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
/**
 * Shared types for `app/api/v1/<resource>/_handler.ts` core functions.
 *
 * Handlers são chamados tanto pelos Route Handlers REST quanto pelo MCP server
 * (S-13.03). O `Actor` discriminado permite que o mesmo handler atenda usuário
 * humano (cookie session) ou agente de IA (Bearer token com actor_type='ai_agent').
 */

export type Actor =
  | { type: "user"; id: string; role?: string }
  /**
   * ⚠️ `id` E `agent_id` NÃO SÃO A MESMA COISA, e confundi-los custa a atividade.
   *
   * `id` é QUEM AGIU para efeito de correlação no audit — e cada runtime põe ali
   * o que tem à mão: o runtime nativo põe o id do RUN (`ai_agent_runs`), o token
   * MCP externo põe o id do run vindo do escopo `agent_run:` (ou o do próprio
   * token), e o envio do motor chega a pôr a string literal `agent-engine`.
   *
   * `agent_id` é a linha em `ai_agents` — a ÚNICA coisa que pode ir para uma
   * coluna com FK, como `crm_lead_activities.actor_agent_id`. Sem esta separação,
   * um id de run viajava para lá e o INSERT morria na FK: a mutação acontecia, a
   * timeline não registrava, e a perda só aparecia em `event_log`. Opcional
   * porque nem todo caminho conhece o agente (token externo, por exemplo) — e
   * "não sei qual agente" tem de virar atividade de sistema, nunca linha perdida.
   */
  | { type: "ai_agent"; id: string; role: string; api_token_id?: string; agent_id?: string }
  | { type: "webhook_source"; id: string };

export interface HandlerCtx {
  agentOperation?: AgentOperationContext;
  meetingDelivery?: MeetingDeliveryContext;
  approvedReply?: ApprovedReplyContext;
  meetingBooking?: MeetingBookingContext;
  internalMessageId?: string;
  proactiveContext?: ProactiveContext;
  /** Trusted origin captured by the runtime, never request-body metadata. */
  serviceBoundary?: ServiceBoundary | null;
  /** Origem de evento derivado; não é campo de input público. */
  serviceOrigin?: ServiceOrigin;
  organization_id: string;
  actor: Actor;
  requestId: string;
}
