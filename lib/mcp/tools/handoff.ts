import { beginServiceAtOrigin, assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
/**
 * MCP special tool — crm_request_human_handoff v2 (Spec 11 §3.3 + G6-01).
 *
 * Side effects (todos via `triggerHandoff` orchestrator + assignment best-effort):
 *   - conversations.status='pending', bot_silenced_until='infinity'
 *   - crm_lead_activities INSERT (type='handoff_triggered') quando há lead vinculado
 *   - event_log INSERT event_type='ai.handoff_triggered'
 *   - Realtime broadcast `org:<org>:queue` event=handoff_pending
 *   - api_audit_log action='ai.handoff_triggered' (+ mcp.tool_called no server core)
 *
 * v2 (G6-01 / INB-12): a ESCOLHA do destino usa o roteamento G5 — UM algoritmo:
 *   - `target_user_id` opcional: se passado E elegível agora (disponível ∧ horário
 *     ∧ folga), atribui a ele;
 *   - senão, rodízio real `selectRoundRobin` sobre os elegíveis (mesma lógica do
 *     worker de roteamento — o antigo pickRoundRobinAssignee random foi removido);
 *   - sem ninguém elegível → fila (fallback), retornando a posição.
 *   Retorno estruturado: { assigned_to } OU { queued: true, position }.
 *   Efeitos auditados (assignment event reason='handoff') preservados nos dois casos.
 */
import { z } from "zod";

import {
  triggerHandoff,
  type HandoffReason,
  type TriggerHandoffResult,
} from "@/lib/ai/handoff/orchestrator";
import { motivoCodigoDoTexto } from "@/lib/escalacao/passagem";
import { loadEligibleAttendants } from "@/lib/routing/eligibles";
import { selectRoundRobin } from "@/lib/routing/decide";
import { getQueuePosition } from "@/lib/routing/queue";
import { logger } from "@/lib/logger";
import type { McpToolDefinition } from "../types";

const inputShape = {
  conversation_id: z.string().uuid(),
  /**
   * ⚠️ **SEM DEFAULT, e isto é o conserto (#3310).** Era
   * `.default("requested_human")`, e um agente externo que passasse a conversa
   * sem declarar o motivo — o caso comum de quem escala por não ter a
   * informação, ou por regra do próprio prompt — fazia o cartão de quem assume
   * afirmar "O cliente pediu para falar com uma pessoa" e o cliente receber a
   * abertura de quem PEDIU um humano. Ausente agora é ausente: o texto é
   * classificado por `motivoCodigoDoTexto`, que devolve o motivo honesto de
   * "o assistente não resolveu sozinho" e nunca inventa um pedido do cliente.
   * Quem ATENDE ao pedido continua mandando `"requested_human"` e recebendo a
   * frase do pedido.
   */
  reason: z.string().min(1).max(500).optional().describe(
    'código do motivo ou texto livre. Envie exatamente "requested_human" quando o cliente pedir uma pessoa; ' +
      "sem isso a passagem fica registrada como low_confidence (o assistente não resolveu sozinho).",
  ),
  urgency: z.enum(["low", "normal", "high"]).default("normal"),
  /**
   * O contexto para quem vai assumir — o mesmo vocabulário da ferramenta nativa
   * do agente (`request_human_handoff`). Sem eles, um agente externo passava a
   * conversa e quem assumia recebia a palavra "requested_human" e mais nada.
   */
  o_que_tentei: z
    .array(
      z.object({
        o_que: z.string().min(1).max(200).describe("o que você tentou"),
        desfecho: z.string().min(1).max(200).optional().describe("no que deu"),
      }),
    )
    .max(6)
    .optional()
    .describe("o que você já tentou, na ordem — evita que a pessoa refaça o mesmo caminho"),
  cliente_quer: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe("o que a pessoa está pedindo, nas palavras dela"),
  /** Atendente alvo opcional: só atribui se elegível agora; senão cai no rodízio G5. */
  target_user_id: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const crmRequestHumanHandoff: McpToolDefinition<typeof inputShape> = {
  name: "crm_request_human_handoff",
  description:
    "Aciona handoff bot→humano. Marca a conversa como pending, silencia o bot e escolhe o " +
    "destino pelo roteamento G5: atende o target_user_id se elegível agora, senão rodízio " +
    "entre os disponíveis; sem ninguém elegível vai para a fila. Registra activity + " +
    "event_log + audit. Retorna assigned_to OU queued+position. Use quando o cliente pedir " +
    "atendente humano ou o agente identificar limite da automação.",
  inputSchema: inputShape,
  category: "handoff",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // Conversation must belong to org (defense in depth — service role bypassa RLS).
    const { data: conv, error: convErr } = await ctx.supabase
      .from("conversations")
      .select("id, organization_id, contact_id, channel_session_id, awaiting_since")
      .eq("organization_id", ctx.organizationId)
      .eq("id", input.conversation_id)
      .maybeSingle();
    if (convErr) throw new Error(convErr.message);
    if (!conv || conv.organization_id !== ctx.organizationId) {
      throw new Error("conversation_not_found");
    }

    const boundary = conv.contact_id ? await beginServiceAtOrigin(ctx.supabase, ctx.organizationId, conv.contact_id, conv.channel_session_id) : undefined;
    if (boundary && boundary.conversation_id !== input.conversation_id) throw new Error("service_scope_mismatch");

    // Try to find a lead linked to this contact (best effort for activity insert).
    let leadId: string | null = null;
    if (conv.contact_id) {
      const { data: leadRow } = await ctx.supabase
        .from("crm_leads")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .eq("contact_id", conv.contact_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      leadId = leadRow?.id ?? null;
    }

    // O `reason` que o agente externo mandou é TEXTO LIVRE de fora. Ele passa a
    // virar código quando corresponde a um do nosso vocabulário, e o texto vai
    // para `content` na linha da passagem.
    //
    // ⚠️ `original_reason` SAIU do metadata, e a razão é de uma linha: o metadata
    // vai para `api_audit_log`, tabela em que NENHUM papel tem GRANT de UPDATE
    // ou DELETE — nem `service_role`. Texto livre de fora gravado ali é texto
    // que a cascata de LGPD não consegue redigir. `content` é redigível.
    const result = await triggerHandoff({
      serviceBoundary: boundary,
      conversationId: input.conversation_id,
      organizationId: ctx.organizationId,
      reason: motivoDoAgenteExterno(input.reason),
      origem: "mcp_externo",
      motivoTexto: input.reason ?? null,
      // Só o que o agente DECLAROU. O contexto acumulado (checkpoint durável e
      // as falas pendentes do cliente) quem lê é o orquestrador, para todos os
      // seus chamadores — um lugar, uma montagem.
      declarado: {
        ...(input.o_que_tentei !== undefined ? { tentativas: input.o_que_tentei } : {}),
        cliente_quer: input.cliente_quer ?? null,
      },
      leadId,
      metadata: {
        source: "ai_agent",
        urgency: input.urgency,
        ...(ctx.actor.type === "ai_agent" ? { run_id: ctx.actor.id } : {}),
        ...(input.metadata ?? {}),
      },
    });

    let assignedUserId: string | null = null;
    let queued = false;
    let position: number | null = null;

    if (result.triggered) {
      const now = new Date();
      // INB-12: mesmos elegíveis do worker de roteamento (G5) — um algoritmo só.
      const eligibles = await loadEligibleAttendants(ctx.supabase, ctx.organizationId, now, {
        kind: "conversation_channel", channelSessionId: conv.channel_session_id,
      });
      const picked =
        input.target_user_id && eligibles.some((e) => e.userId === input.target_user_id)
          ? input.target_user_id
          : selectRoundRobin(eligibles);

      if (picked) {
        // G3-02: reassignment auditado — UPDATE (kind ai→'user') + evento
        // reason='handoff' na MESMA transação (fn_conversation_assign, 0031/0032).
        if (boundary) await assertServiceBoundarySupabase(ctx.supabase, boundary);
        const { data: claimed, error: assignErr } = await ctx.supabase.rpc("fn_channel_routing_claim", {
          p_org: ctx.organizationId, p_conversation: input.conversation_id,
          p_channel: conv.channel_session_id, p_user: picked, p_reason: "handoff",
          p_schedule: eligibles.find((candidate) => candidate.userId === picked)?.scheduleSnapshot ?? {},
        });
        if (assignErr || claimed !== "assigned") {
          logger.warn("[mcp.handoff] assignment failed", {
            conversation_id: input.conversation_id,
            error: assignErr?.message ?? "0 rows (conversation not found)",
          });
        } else {
          assignedUserId = picked;
        }
      }

      if (!assignedUserId) {
        // CAS: não apaga o kind de um dono que venceu entre seleção e claim.
        const { data: queuedRows, error: kindErr } = await ctx.supabase
          .from("conversations").update({ assignee_kind: null })
          .eq("id", input.conversation_id).eq("organization_id", ctx.organizationId)
          .is("assigned_to_user_id", null).in("status", ["open", "pending", "ai_handling"])
          .select("id");
        if (kindErr) throw new Error(kindErr.message);
        if (!queuedRows?.length) {
          const { data: current, error } = await ctx.supabase.from("conversations")
            .select("assigned_to_user_id").eq("id", input.conversation_id)
            .eq("organization_id", ctx.organizationId).maybeSingle();
          if (error) throw new Error(error.message);
          assignedUserId = current?.assigned_to_user_id ?? null;
        } else {
          const { error } = await ctx.supabase.rpc("fn_request_channel_routing", {
            p_org: ctx.organizationId, p_conversation: input.conversation_id,
          });
          if (error) throw new Error(error.message);
        }
        queued = Boolean(queuedRows?.length);
        position = queued ? await getQueuePosition(
          ctx.supabase,
          ctx.organizationId,
          conv.awaiting_since ?? null,
          now,
        ) : null;
      }
    }

    return {
      handoff_recorded: result.triggered,
      conversation_id: input.conversation_id,
      // Retorno estruturado v2: um destes dois lados é populado.
      assigned_to: assignedUserId,
      queued,
      position,
      // Compat com o contrato anterior (callers que liam assigned_to_user_id).
      assigned_to_user_id: assignedUserId,
      idempotent: !result.triggered && result.reason === "idempotent_5s",
      // ⚠️ MUDOU. A frase anterior mandava avisar o cliente DEPOIS de o
      // orquestrador já ter avisado (ele manda a mensagem no passo 0), então o
      // agente externo que obedecesse mandava a mesma coisa duas vezes. Agora a
      // resposta declara o desfecho REAL do aviso — e quando ele não saiu, quem
      // precisa saber disso é o time, que já foi alertado, não o agente.
      next_action: proximoPasso(result),
    };
  },
};

/**
 * O que o agente externo faz A SEGUIR — derivado do desfecho real, nunca fixo.
 *
 * O aviso ao cliente é responsabilidade do orquestrador (passo 0 de
 * `triggerHandoff`), e ele acontece antes de esta função existir. Repetir a
 * instrução "avise o cliente" aqui era mandar mandar de novo.
 */
function proximoPasso(result: TriggerHandoffResult): string {
  if (!result.triggered) {
    return "A conversa não saiu do atendimento automático — encerre o turno e não prometa nada ao cliente.";
  }
  if (result.aviso?.avisado === true) {
    return "O cliente já foi avisado de que uma pessoa vai assumir — encerre o turno.";
  }
  return (
    "Não foi possível avisar o cliente (o canal não entregou a mensagem); a equipe foi alertada disso. " +
    "Encerre o turno."
  );
}

/**
 * O `reason` que o agente externo mandou, reduzido ao vocabulário DESTE motor.
 *
 * `motivoCodigoDoTexto` conhece os dez motivos do banco; `triggerHandoff` grava
 * `conversations.last_handoff_reason` e aceita os sete dele. Os três que ficam de
 * fora (`suspected_optout`, `caso_escalado` e `verificacao_manual`) nascem de
 * caminhos internos — um agente externo que os escrevesse estaria declarando um
 * fato que ele não observou (`verificacao_manual` é o motivo com que o runtime
 * grava a passagem quando um fluxo determinístico entrega o turno). O texto
 * inteiro não se perde: ele vai para `content`.
 *
 * ⚠️ **Estes três NÃO viram `requested_human` (#3310).** Viravam, e o efeito era
 * o defeito que a issue mediu: o agente externo escrevia o próprio motivo (ou
 * nenhum) e o cartão de quem assume dizia "O cliente pediu para falar com uma
 * pessoa". Código que o agente não pode declarar cai no mesmo lugar da ausência
 * — `low_confidence`, o motivo honesto de "o assistente não resolveu sozinho" —,
 * e o pedido real do cliente continua sendo `requested_human`, escrito com todas
 * as letras por quem o atendeu.
 */
function motivoDoAgenteExterno(texto: string | null | undefined): HandoffReason {
  const codigo = motivoCodigoDoTexto(texto);
  return codigo === "suspected_optout" || codigo === "caso_escalado" || codigo === "verificacao_manual"
    ? "low_confidence"
    : codigo;
}
