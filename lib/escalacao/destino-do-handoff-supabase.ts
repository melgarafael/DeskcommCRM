/**
 * A PORTA DO MOTOR DO CRM (supabase-js) para `entregarAoDonoDoHandoff`.
 *
 * `triggerHandoff` (`lib/ai/handoff/orchestrator`) é o funil do motor que fala
 * supabase-js: o agente MCP externo, o worker de sentimento, o runtime e os
 * gatilhos G1-G4 passam todos por lá. A decisão de QUEM recebe não mora aqui —
 * mora em `lib/escalacao/destino-do-handoff` —, e esta porta só responde às
 * perguntas dela e executa a escrita que ela mandou.
 *
 * A escrita é `fn_conversation_assign` com `reason = 'handoff'`: a MESMA porta
 * da atribuição que o botão Transferir, o "Assumir" e o claim do roteamento
 * usam. Ela grava `conversation_assignment_events` na mesma transação, então a
 * trilha da atribuição continua sendo a de sempre — esta entrega não inventa
 * uma segunda auditoria.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { conferirVinculoDoDestino } from "@/lib/automation/vinculo-do-destino";
import type {
  ConversaDaEntrega,
  PortaDaEntrega,
} from "@/lib/escalacao/destino-do-handoff";

/** `null` = ninguém achou / linha ausente. Erro de leitura vira ausência: a entrega não derruba o handoff. */
export function portaDaEntregaSupabase(admin: SupabaseClient): PortaDaEntrega {
  return {
    async lerSettings(organizationId) {
      const { data } = await admin
        .from("organizations")
        .select("settings")
        .eq("id", organizationId)
        .maybeSingle();
      return (data as { settings?: unknown } | null)?.settings ?? null;
    },

    async lerConversa(organizationId, conversationId) {
      const { data } = await admin
        .from("conversations")
        .select("assigned_to_user_id, assignee_kind, contact_id")
        .eq("organization_id", organizationId)
        .eq("id", conversationId)
        .maybeSingle();
      if (!data) return null;
      const linha = data as {
        assigned_to_user_id?: string | null;
        assignee_kind?: string | null;
        contact_id?: string | null;
      };
      return {
        assigned_to_user_id: linha.assigned_to_user_id ?? null,
        assignee_kind: linha.assignee_kind ?? null,
        contact_id: linha.contact_id ?? null,
      } satisfies ConversaDaEntrega;
    },

    /**
     * O negócio ABERTO mais recente do contato — a mesma leitura de
     * `negocio-aberto-do-contato` (#3177): encerrado, ganho ou perdido é
     * histórico, e o pós-venda que a IA está passando é o card em aberto.
     */
    async lerNegocioDoContato(organizationId, contactId) {
      const { data } = await admin
        .from("crm_leads")
        .select("owner_user_id, owner_kind")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("status", "open")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data as { owner_user_id?: unknown; owner_kind?: unknown } | null) ?? null;
    },

    async lerContato(organizationId, contactId) {
      const { data } = await admin
        .from("contacts")
        .select("carteira_user_id")
        .eq("organization_id", organizationId)
        .eq("id", contactId)
        .maybeSingle();
      return (data as { carteira_user_id?: unknown } | null) ?? null;
    },

    conferirVinculo: (organizationId, userId) =>
      conferirVinculoDoDestino(admin, organizationId, userId),

    async atribuir(organizationId, conversationId, userId) {
      const { error } = await admin.rpc("fn_conversation_assign", {
        p_organization_id: organizationId,
        p_conversation_id: conversationId,
        p_to_user_id: userId,
        p_reason: "handoff",
      });
      return error ? error.message : null;
    },

    /**
     * O rodízio do canal: a conversa entra na distribuição que já existe
     * (`fn_request_channel_routing` emite `conversation.routing_requested`, e o
     * worker de roteamento escolhe quem da fila atende). É a mesma porta que o
     * handoff da IA usa hoje quando não há ninguém elegível — o fallback não
     * inventa uma segunda distribuição.
     */
    async enfileirarNoRodizio(organizationId, conversationId) {
      const { error } = await admin.rpc("fn_request_channel_routing", {
        p_org: organizationId,
        p_conversation: conversationId,
      });
      return error ? error.message : null;
    },
  };
}
