/**
 * O FOLLOW-UP DA PROSPECÇÃO MORRE COM O "NÃO TENHO INTERESSE" (decisão D3).
 *
 * ═══ Por que existe ═══
 *
 * A recusa de marketing barra a prospecção, as Campanhas e as automações, mas nenhum
 * caminho do motor de follow-up lê `consent`. E a resposta do cliente ACORDA a
 * inscrição sem `cancel_on_reply` (`reactivity.ts`, `inbound_woke`): sem este passo, o
 * próximo toque da retomada saía logo depois do "não tenho interesse". O PARAR não
 * sofre disso porque o `is_blocked` cancela tudo; a recusa não bloqueia o contato, e
 * por isso precisa encerrar o que está vivo.
 *
 * ═══ O que morre, e o que fica ═══
 *
 * Só a inscrição da PROSPECÇÃO: a da conversa onde a frase chegou, ou a de qualquer
 * conversa aberta por uma campanha (`metadata.prospecting_campaign_id`). Um follow-up
 * de atendimento (o lembrete da consulta, o orçamento que o cliente pediu) não morre
 * porque ele não quer receber ofertas. Inscrição sem conversa fica: não há como
 * provar que é da prospecção.
 *
 * Os status alcançados são os do opt-out (vivos, dormente, coletando e pausados): uma
 * espera longa que sobrevivesse voltaria a falar com quem recusou.
 *
 * ═══ Idempotência: o UPDATE primeiro, o evento depois ═══
 *
 * O UPDATE casa apenas com o status ainda vivo — um cancelamento concorrente não é
 * sobrescrito — e só quando ele mudou a linha entra o evento, com chave por inscrição.
 * Na ordem inversa (evento primeiro, como em `saida-da-etapa.ts`), um UPDATE que
 * falhasse deixava a chave gravada: a frase repetida batia no 23505 e a inscrição
 * nunca morria; e um UPDATE que não casava deixava na timeline um "encerrado" que
 * não aconteceu.
 *
 * NUNCA lança: a recusa já está gravada. A falha fica no log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { campanhaDeProspeccaoDaConversa } from "@/lib/lgpd/sem-interesse";
import { logger } from "@/lib/logger";

/** A linha da timeline do follow-up (`eventos-legiveis.ts` a descreve). */
export const EVENTO_DA_RECUSA = "cancelled_sem_interesse";

/** O `cancel_reason` que a fila mostra. */
export const MOTIVO_DA_RECUSA = "sem_interesse";

/** Os mesmos status que o opt-out alcança (`reactivity.ts`). */
export const STATUS_QUE_A_RECUSA_ALCANCA = [
  "active",
  "waiting_reply",
  "paused_handoff",
  "dormente",
  "coletando",
  "paused_manual",
] as const;

export interface PedidoDeEncerramento {
  organizationId: string;
  contactId: string;
  /** A conversa da frase, quando a recusa veio dela: a inscrição dela morre sem consulta. */
  conversationId?: string;
}

interface Inscricao {
  id: string;
  status: string;
  current_node_id: string | null;
  conversation_id: string | null;
}

/** Encerra as inscrições de follow-up da prospecção do contato. Devolve quantas morreram. */
export async function encerrarFollowupsDaProspeccao(
  admin: SupabaseClient,
  pedido: PedidoDeEncerramento,
): Promise<number> {
  try {
    const { data, error } = await admin
      .from("followup_enrollments")
      .select("id, status, current_node_id, conversation_id")
      .eq("organization_id", pedido.organizationId)
      .eq("contact_id", pedido.contactId)
      .in("status", [...STATUS_QUE_A_RECUSA_ALCANCA]);
    if (error) throw new Error(error.message);
    const vivas = ((data ?? []) as Inscricao[]).filter((i) => i.conversation_id);
    if (vivas.length === 0) return 0;

    const daProspeccao = new Set<string>();
    if (pedido.conversationId) daProspeccao.add(pedido.conversationId);
    const aConferir = [...new Set(vivas.map((i) => i.conversation_id as string))].filter(
      (id) => !daProspeccao.has(id),
    );
    if (aConferir.length > 0) {
      const { data: conversas, error: errConversas } = await admin
        .from("conversations")
        .select("id, metadata")
        .eq("organization_id", pedido.organizationId)
        .in("id", aConferir);
      if (errConversas) throw new Error(errConversas.message);
      for (const c of (conversas ?? []) as Array<{ id: string; metadata: unknown }>) {
        if (campanhaDeProspeccaoDaConversa(c.metadata)) daProspeccao.add(c.id);
      }
    }

    let encerradas = 0;
    const agora = new Date().toISOString();
    for (const inscricao of vivas) {
      if (!daProspeccao.has(inscricao.conversation_id as string)) continue;

      const { data: mudou, error: errUpdate } = await admin
        .from("followup_enrollments")
        .update({
          status: "cancelled",
          outcome: "opted_out",
          cancel_reason: MOTIVO_DA_RECUSA,
          next_eval_at: null,
          claimed_until: null,
          completed_at: agora,
          updated_at: agora,
        })
        .eq("organization_id", pedido.organizationId)
        .eq("id", inscricao.id)
        .in("status", [...STATUS_QUE_A_RECUSA_ALCANCA])
        // Sem o `select`, um UPDATE que não casa nada responde sem erro e contaria
        // um encerramento que não houve.
        .select("id");
      if (errUpdate) throw new Error(errUpdate.message);
      if ((mudou ?? []).length === 0) continue;
      encerradas += 1;

      const { error: errEvento } = await admin.from("followup_enrollment_events").insert({
        organization_id: pedido.organizationId,
        enrollment_id: inscricao.id,
        node_id: inscricao.current_node_id,
        event_type: EVENTO_DA_RECUSA,
        payload: { reason: MOTIVO_DA_RECUSA, previous_status: inscricao.status },
        idempotency_key: `sem-interesse:${inscricao.id}`,
      });
      if (errEvento) {
        // 23505 é a chave de idempotência: o evento desta inscrição já existe. A
        // inscrição está encerrada (o UPDATE acima casou), e a falha do evento não a
        // desfaz: fica no log.
        if (errEvento.code !== "23505")
          logger.warn("sem-interesse: inscrição encerrada sem a linha da timeline", {
            organization_id: pedido.organizationId,
            enrollment_id: inscricao.id,
            detail: errEvento.message.slice(0, 160),
          });
      }
    }
    return encerradas;
  } catch (err) {
    logger.error("sem-interesse: follow-up da prospecção NAO encerrado — a retomada pode sair", {
      organization_id: pedido.organizationId,
      contact_id: pedido.contactId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return 0;
  }
}
