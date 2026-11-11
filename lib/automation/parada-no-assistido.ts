/**
 * Doc 301 = B: no modo ASSISTIDO, quando quem mexe é a IA, a automação não fala
 * com o cliente sozinha.
 *
 * O modo assistido promete "nada sai sem alguém aprovar". O Operador passou a
 * organizar o card também no assistido (#4319), e mover o card dispara as
 * automações da etapa — algumas mandam WhatsApp, e-mail, mensagem da IA ou
 * inscrevem numa sequência. Essas quatro ficam PARADAS; o resto da regra
 * (etiqueta, tarefa, aviso à equipe) roda como sempre. A Central ganha um aviso
 * com o que ficou parado, e quem pode disparar decide.
 *
 * QUEM marca o evento é o emissor, no momento da ação: o ator `ai_agent` leva
 * `operation_mode: "assisted"` (montado em `lib/agent-engine/edge/crm/mcp-tools.ts`)
 * e o handler grava `actor_operation_mode` no `metadata`. A marca é do momento:
 * trocar o agente para automático depois não solta o que já ficou parado.
 * Evento sem a marca (pessoa, automático, sistema) segue exatamente como antes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";

/** As ações que falam com o cliente — a lista literal do doc 301. */
export const ACOES_QUE_FALAM_COM_O_CLIENTE: readonly string[] = [
  "send_whatsapp_message",
  "send_email",
  "send_ai_message",
  "start_message_flow",
];

/** O código gravado no recibo da ação parada (`ActionResultDetail.error`). */
export const MOTIVO_PARADA_NO_ASSISTIDO = "parada_no_assistido";

/** `ref_kind` do aviso: aponta para o run que guarda o que ficou parado. */
export const REF_DO_AVISO_DE_PARADA = "automation_rule_run";

/** O pedaço de `metadata` que o emissor acrescenta quando o ator é a IA no assistido. */
export function marcaDoAssistido(actor: Actor): { actor_operation_mode?: "assisted" } {
  return actor.type === "ai_agent" && actor.operation_mode === "assisted"
    ? { actor_operation_mode: "assisted" }
    : {};
}

export function eventoDaIaNoAssistido(row: Pick<EventRow, "metadata">): boolean {
  return (row.metadata as Record<string, unknown> | null | undefined)?.actor_operation_mode === "assisted";
}

export function acaoFicaParada(row: Pick<EventRow, "metadata">, tipoDaAcao: string): boolean {
  return eventoDaIaNoAssistido(row) && ACOES_QUE_FALAM_COM_O_CLIENTE.includes(tipoDaAcao);
}

const NOME_DA_ACAO: Record<string, string> = {
  send_whatsapp_message: "WhatsApp",
  send_email: "e-mail",
  send_ai_message: "mensagem da IA",
  start_message_flow: "sequência",
};

/**
 * Abre o aviso na Central. Fire-and-forget como os outros avisos do motor: um
 * aviso que não entra não desfaz o que a regra já fez — mas vira log de erro,
 * porque sem ele a mensagem parada fica invisível.
 */
export async function avisarAcoesParadas(
  admin: SupabaseClient,
  entrada: { organizationId: string; ruleName: string; runId: string; tipos: readonly string[] },
): Promise<void> {
  const nomes = [...new Set(entrada.tipos.map((t) => NOME_DA_ACAO[t] ?? t))].join(", ");
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: entrada.organizationId,
    kind: "other",
    severity: "warn",
    title: "Automação esperando aprovação para falar com o cliente",
    body:
      `Uma ação da IA no modo assistido disparou a automação "${entrada.ruleName}", e o que fala com o cliente ficou parado (${nomes}). ` +
      `O resto da automação já rodou. Dispare se quiser que a mensagem saia; marque como resolvido para descartar.`,
    ref_kind: REF_DO_AVISO_DE_PARADA,
    ref_id: entrada.runId,
  });
  if (error) {
    logger.error("[automation] aviso de ação parada no assistido não entrou na Central", {
      organization_id: entrada.organizationId,
      error: error.message,
    });
  }
}
