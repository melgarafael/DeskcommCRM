import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRow } from "@/lib/event-log/dispatcher";

export interface ActionResultDetail {
  type: string;
  status: "success" | "failed" | "skipped" | "postponed";
  error?: string;
  detail?: Record<string, unknown>;
}

export interface ActionCtx {
  /** Privado à execução: nunca vem do payload nem do contexto de condições. */
  serviceBoundaries?: Map<string, Promise<ServiceBoundary>>;
  admin: SupabaseClient;
  organizationId: string;
  ruleId: string;
  /** Nome da regra como o operador a nomeou — entra nos avisos que ele lê. */
  ruleName: string;
  event: EventRow;
  context: Record<string, unknown>; // mesmo objeto avaliado pelas condições
  requestId: string;
}

export interface ActionExecutor {
  type: string;
  /** Pré-checagem opcional: se retornar um ISO timestamp, o EVENTO INTEIRO é
   *  adiado para essa hora ANTES de qualquer ação executar (all-or-nothing —
   *  evita reexecução parcial no retry). Usada pelo throttle do WhatsApp. */
  postponeUntil?(ctx: ActionCtx, config: Record<string, unknown>): Promise<string | null>;
  execute(ctx: ActionCtx, config: Record<string, unknown>): Promise<ActionResultDetail>;
}
