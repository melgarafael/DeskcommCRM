/**
 * Handoff orchestrator — central point que executa a transição bot→humano
 * para os 4 gatilhos OR-lógicos (G1/G2/G3/G4) do EPIC-06.
 *
 * Efeitos colaterais (atomic-ish; falhas não-críticas são logadas e ignoradas):
 *   1. UPDATE conversations
 *        SET status='pending',
 *            bot_silenced_until='infinity',
 *            last_handoff_at=now(),
 *            last_handoff_reason=<reason>,
 *            active_ai_agent_id=null, active_intent=null, active_agent_set_at=null
 *      (idempotente: se outro handoff aconteceu nos últimos 5s com mesma reason,
 *       skip — tratamento de race G2 vs G3 vs G4 simultâneos.)
 *   2. INSERT em crm_lead_activities (timeline) se houver lead_id
 *   2.5. Move o lead para a etapa `crm_stages.slug='chamar-humano'` do
 *        pipeline dele, se o tenant tiver criado essa etapa (opt-in — ver
 *        `lib/leads/handoff-stage-move.ts`). Pipeline sem essa etapa: no-op.
 *   3. emit_event('ai.handoff_triggered') no event_log
 *   4. Realtime broadcast no channel 'org:<org>:queue' (event 'handoff_pending')
 *   5. api_audit_log action='ai.handoff_triggered'
 *
 * IMPORTANTE: nunca propaga exceção pro caller. O worker chamador segue feliz.
 *
 * Service-role bypassa RLS — filtro `organization_id` programático em toda query.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { moverLeadParaEtapaDeHandoff } from "@/lib/leads/handoff-stage-move";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";

import { avisarLeadDoCrm } from "./aviso-ao-lead";

export type HandoffReason =
  | "requested_human"
  | "low_sentiment"
  | "low_confidence"
  | "critical_stage"
  | "legal_mention"
  | "refund_mention"
  /**
   * O teto de gasto com IA parou o atendimento automático. NÃO é pedido do lead —
   * quem lê `last_handoff_reason` precisa distinguir, porque a primeira frase que
   * o humano digita depende disso.
   *
   * O literal vem de `HANDOFF_REASON_ORCAMENTO` (`lib/agent-engine/edge/llm/orcamento.ts`),
   * a MESMA constante que o engine grava: dois caminhos param a IA pelo mesmo
   * motivo, e duas grafias fariam quem filtra por uma achar metade das conversas.
   */
  | "orcamento_de_ia";

export interface TriggerHandoffInput {
  conversationId: string;
  organizationId: string;
  reason: HandoffReason;
  leadId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TriggerHandoffResult {
  triggered: boolean;
  reason: string;
}

const IDEMPOTENCY_WINDOW_MS = 5_000;
// Postgres `infinity` literal — bot must never reassume after handoff (IA-06).
const SILENCE_INFINITY = "infinity";

export async function triggerHandoff(
  input: TriggerHandoffInput,
): Promise<TriggerHandoffResult> {
  try {
    const admin = createAdminClient();

    // Idempotency check: se um handoff aconteceu há <5s pra esta conversa COM
    // a mesma reason, é provavelmente uma race entre G2/G3/G4 disparando em
    // paralelo. Skip silenciosamente.
    const { data: convNow } = await admin
      .from("conversations")
      .select("id, organization_id, contact_id, last_handoff_at, last_handoff_reason")
      .eq("id", input.conversationId)
      .eq("organization_id", input.organizationId)
      .maybeSingle();

    if (!convNow) {
      return { triggered: false, reason: "conversation_not_found" };
    }

    type ConvNowRow = {
      id: string;
      organization_id: string;
      last_handoff_at: string | null;
      last_handoff_reason: string | null;
    };
    const c = convNow as unknown as ConvNowRow;

    if (c.last_handoff_at) {
      const since = Date.now() - new Date(c.last_handoff_at).getTime();
      if (since < IDEMPOTENCY_WINDOW_MS && c.last_handoff_reason === input.reason) {
        return { triggered: false, reason: "idempotent_5s" };
      }
    }

    // GATE DE ELEGIBILIDADE — só se passa bot→humano uma conversa que a IA
    // PODERIA estar atendendo agora. Se `decidirElegibilidade` já diz não —
    // porque o gate `allowlist` barra o contato (cliente antigo irritado →
    // `low_sentiment` do worker de sentimento), OU porque já está de forma
    // duradoura silenciada/em handoff/com dono humano —, NÃO há o que passar: disparar
    // mandaria "um humano vai te atender" (às vezes de novo) e mexeria no
    // estado de uma conversa que não é da IA. Fail-closed: erro de leitura →
    // não dispara (o evento re-tenta).
    try {
      const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        agora: new Date(),
        ttlMs: ttlDaAutorizacaoMs(process.env),
      });
      if (elegib !== null && !elegib.permite) {
        return { triggered: false, reason: `nao_elegivel:${elegib.motivo}` };
      }
    } catch (err) {
      logger.warn("[handoff] elegibilidade indeterminada — handoff não disparado", {
        conversation_id: input.conversationId,
        detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
      });
      return { triggered: false, reason: "elegibilidade_indeterminada" };
    }

    const nowIso = new Date().toISOString();

    // Step 0 — AVISA O LEAD. Antes de tudo, e este é o passo que faltava.
    //
    // Medido em produção (conversa `b934ba2d`, 2026-08-26): o agente PERGUNTOU o
    // e-mail do cliente, o worker de sentimento disparou este caminho entre a
    // pergunta e a resposta, e o cliente respondeu para o vazio. A passagem
    // funcionava; a pessoa do outro lado é que não existia para o código.
    //
    // Precisa do `contact_id` — é a semente da variante do texto. Sem ele
    // (conversa órfã, que a UI não mostra) seguimos sem avisar: o handoff é mais
    // importante que o aviso, e a falta vira linha no item da Central abaixo.
    const contactId = (convNow as unknown as { contact_id?: string | null }).contact_id ?? null;
    const aviso =
      contactId === null
        ? { avisado: false, porque: "conversa_sem_contato" }
        : await avisarLeadDoCrm(admin, {
            organizationId: input.organizationId,
            conversationId: input.conversationId,
            contactId,
            reason: input.reason,
          });

    // Step 1 — flip conversation to pending + silence bot indefinitely.
    // We use 'infinity' (Postgres timestamp special) so any later comparison
    // `bot_silenced_until > now()` is always true. supabase-js sends as text
    // and Postgres parses correctly for timestamptz columns.
    const { error: updErr } = await admin
      .from("conversations")
      .update({
        status: "pending",
        bot_silenced_until: SILENCE_INFINITY,
        last_handoff_at: nowIso,
        last_handoff_reason: input.reason,
        status_changed_at: nowIso,
        // Fase 3 (review T5, finding 4): zera a aderência ao agente do router — se o
        // bot for reativado, o router decide de novo (não reassume por inércia).
        active_ai_agent_id: null,
        active_intent: null,
        active_agent_set_at: null,
      })
      .eq("id", input.conversationId)
      .eq("organization_id", input.organizationId);

    if (updErr) {
      logger.warn("[handoff-orchestrator] conversation update failed", {
        conversation_id: input.conversationId,
        error: updErr.message,
      });
      return { triggered: false, reason: "orchestrator_error" };
    }

    // Step 2 — timeline activity (best-effort; missing leadId is OK).
    if (input.leadId) {
      const { error: actErr } = await admin.from("crm_lead_activities").insert({
        organization_id: input.organizationId,
        lead_id: input.leadId,
        type: "handoff_triggered",
        source_module: "ai",
        payload: {
          conversation_id: input.conversationId,
          reason: input.reason,
        },
        metadata: {
          actor_kind: "system",
          reason: input.reason,
          ...(input.metadata ?? {}),
        },
      });
      if (actErr) {
        logger.warn("[handoff-orchestrator] activity insert failed", {
          lead_id: input.leadId,
          error: actErr.message,
        });
      }

      // Step 2.5 — best-effort: move o card para a etapa "chamar humano" do
      // pipeline dele, quando o tenant configurou uma (ver docstring do
      // arquivo). Nunca bloqueia nem derruba o handoff em si.
      await moverLeadParaEtapaDeHandoff(admin, {
        organizationId: input.organizationId,
        leadId: input.leadId,
        reason: input.reason,
      }).catch((err) => {
        logger.warn("[handoff-orchestrator] moverLeadParaEtapaDeHandoff failed", {
          lead_id: input.leadId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Step 3 — durable event for any downstream consumer.
    const { error: emitErr } = await admin.rpc("emit_event" as never, {
      p_event_type: "ai.handoff_triggered",
      p_entity_kind: "conversation",
      p_entity_id: input.conversationId,
      p_payload: {
        conversation_id: input.conversationId,
        organization_id: input.organizationId,
        reason: input.reason,
        lead_id: input.leadId ?? null,
        metadata: input.metadata ?? {},
      },
      p_metadata: { source: "handoff-orchestrator" },
      p_organization_id: input.organizationId,
    } as never);
    if (emitErr) {
      logger.warn("[handoff-orchestrator] emit_event failed", {
        conversation_id: input.conversationId,
        error: (emitErr as { message?: string }).message ?? String(emitErr),
      });
    }

    // Step 4 — Realtime broadcast so the agent UI lights up immediately.
    try {
      const channel = admin.channel(`org:${input.organizationId}:queue`);
      await channel.send({
        type: "broadcast",
        event: "handoff_pending",
        payload: {
          conversation_id: input.conversationId,
          reason: input.reason,
        },
      });
      await admin.removeChannel(channel);
    } catch (err) {
      logger.warn("[handoff-orchestrator] realtime broadcast failed", {
        conversation_id: input.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Step 5 — audit log (fire-and-forget; never blocks).
    const { error: auditErr } = await admin.from("api_audit_log").insert({
      action: "ai.handoff_triggered",
      organization_id: input.organizationId,
      resource_type: "conversation",
      resource_id: input.conversationId,
      metadata: {
        reason: input.reason,
        lead_id: input.leadId ?? null,
        ...(input.metadata ?? {}),
      },
    });
    if (auditErr) {
      logger.warn("[handoff-orchestrator] audit insert failed", {
        conversation_id: input.conversationId,
        error: auditErr.message,
      });
    }

    // Step 6 — o aviso na CENTRAL, para uma pessoa de verdade puxar a conversa.
    //
    // Faltava, e a falta era grave: este motor devolvia a conversa à fila
    // (`status='pending'`) e silenciava a IA, mas não abria item nenhum em
    // `agent_inbox_items` — só `performHumanHandoff` abria. O resultado é o
    // invariante 4 do Sistema Vivo quebrado nos dois sentidos ao mesmo tempo: o
    // cliente sem resposta E o time sem sinal de que havia alguém esperando.
    //
    // Dedup por episódio ABERTO, o mesmo padrão do irmão do motor: dois
    // gatilhos disparando na mesma conversa (sentimento + termo jurídico, por
    // exemplo) rendem UM item, não dois.
    //
    // A chave do dedup é a MESMA de `performHumanHandoff`
    // (`kind='handoff'`, `ref_kind='contact'`, `ref_id=<contato>`, `status='open'`),
    // de propósito: assim os DOIS motores deduplicam um contra o outro, e uma
    // conversa escalada por sentimento e depois por pedido explícito não vira
    // dois avisos para a mesma pessoa.
    if (contactId !== null) {
      try {
        const { data: aberto } = await admin
          .from("agent_inbox_items")
          .select("id")
          .eq("organization_id", input.organizationId)
          .eq("kind", "handoff")
          .eq("ref_kind", "contact")
          .eq("ref_id", contactId)
          .eq("status", "open")
          .limit(1)
          .maybeSingle();
        if (!aberto) {
          const { error: inboxErr } = await admin.from("agent_inbox_items").insert({
            organization_id: input.organizationId,
            kind: "handoff",
            severity: "critical",
            title: "Atendimento automático parou — assumir a conversa",
            body:
              `Motivo: ${input.reason}. ` +
              (aviso.avisado
                ? "O cliente JÁ FOI avisado de que uma pessoa vai assumir."
                : `⚠️ O cliente NÃO foi avisado (${aviso.porque ?? "motivo desconhecido"}) — ele está esperando sem saber.`),
            ref_kind: "contact",
            ref_id: contactId,
          });
          if (inboxErr) {
            logger.warn("[handoff-orchestrator] inbox item insert failed", {
              conversation_id: input.conversationId,
              error: inboxErr.message,
            });
          }
        }
      } catch (err) {
        // Fire-and-forget como os passos 2..5: o aviso é o alerta, não a ação.
        logger.warn("[handoff-orchestrator] inbox item skipped", {
          conversation_id: input.conversationId,
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
      }
    }

    return { triggered: true, reason: input.reason };
  } catch (err) {
    logger.warn("[handoff-orchestrator] unexpected error", {
      conversation_id: input.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { triggered: false, reason: "orchestrator_error" };
  }
}
