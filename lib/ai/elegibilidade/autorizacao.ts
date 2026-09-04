/**
 * ESCREVER a autorização de IA de um contato — num lugar só.
 *
 * As quatro origens elegíveis (webhook do Respondi, match de campanha na
 * ingestão, ação de automação `send_ai_message`, retomada manual pela tela)
 * chamam `autorizarContatoParaIA`. A `reason` é o rastro: quem lê
 * `contacts.ai_authorized_reason` sabe por que a IA pôde assumir.
 *
 * `revogarAutorizacaoDeIA` é o oposto — usado quando um humano assume o
 * atendimento (a retomada para a IA re-autoriza; a passagem para humano revoga).
 * `force_human` continua sendo a trava dura e irrevogável pelo agente; isto aqui
 * é a camada de elegibilidade, não a de handoff.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export type MotivoDeAutorizacao =
  | `respondi:${string}`
  | `campanha:${string}`
  | `automacao:${string}`
  | "retomada_manual";

/**
 * Carimba `contacts.ai_authorized_at = now()` + `ai_authorized_reason`.
 * Best-effort: falha vira log, nunca derruba o fluxo que chamou (webhook,
 * ingestão, automação). Um contato que não ficou autorizado por erro de banco
 * simplesmente segue com atendimento humano — o lado seguro.
 *
 * `apenasSeNaoAutorizado`: quando `true`, não re-carimba um contato que já tem
 * `ai_authorized_at` (evita que match de campanha em toda mensagem fique
 * reescrevendo a origem de um lead que veio do Respondi).
 */
export async function autorizarContatoParaIA(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    contactId: string;
    reason: MotivoDeAutorizacao;
    apenasSeNaoAutorizado?: boolean;
  },
): Promise<{ ok: boolean; autorizou: boolean }> {
  try {
    let q = supabase
      .from("contacts")
      .update({
        ai_authorized_at: new Date().toISOString(),
        ai_authorized_reason: input.reason,
      })
      .eq("organization_id", input.organizationId)
      .eq("id", input.contactId);

    if (input.apenasSeNaoAutorizado) {
      q = q.is("ai_authorized_at", null);
    }

    const { data, error } = await q.select("id").maybeSingle();
    if (error) {
      logger.warn("[elegibilidade] autorização de IA não gravada", {
        organization_id: input.organizationId,
        contact_id: input.contactId,
        reason: input.reason,
        detail: error.message.slice(0, 160),
      });
      return { ok: false, autorizou: false };
    }
    return { ok: true, autorizou: data != null };
  } catch (err) {
    logger.warn("[elegibilidade] autorização de IA falhou", {
      organization_id: input.organizationId,
      contact_id: input.contactId,
      reason: input.reason,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return { ok: false, autorizou: false };
  }
}

/**
 * Limpa a autorização — a IA volta a NÃO responder (no gate 'allowlist') até
 * alguém re-autorizar. Best-effort pela mesma razão.
 */
export async function revogarAutorizacaoDeIA(
  supabase: SupabaseClient,
  input: { organizationId: string; contactId: string },
): Promise<void> {
  try {
    const { error } = await supabase
      .from("contacts")
      .update({ ai_authorized_at: null, ai_authorized_reason: null })
      .eq("organization_id", input.organizationId)
      .eq("id", input.contactId);
    if (error) {
      logger.warn("[elegibilidade] revogação de autorização de IA não gravada", {
        organization_id: input.organizationId,
        contact_id: input.contactId,
        detail: error.message.slice(0, 160),
      });
    }
  } catch (err) {
    logger.warn("[elegibilidade] revogação de autorização de IA falhou", {
      organization_id: input.organizationId,
      contact_id: input.contactId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
}
