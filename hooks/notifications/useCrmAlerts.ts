"use client";

import { useCallback, useRef } from "react";

import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { avisosDoNegocio, estadoDoAntigo, estadoDoNovo, type AvisoDeNegocio, type EstadoVisto } from "./aviso-de-negocio";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { entregarAviso } from "@/lib/notifications/deliver";
import { mencaoAtingeUsuario, textoLegivelDeMencao } from "@/lib/notifications/mentions";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function sides(payload: unknown): {
  novo: Record<string, unknown> | null;
  antigo: Record<string, unknown> | null;
} {
  if (!payload || typeof payload !== "object") return { novo: null, antigo: null };
  const p = payload as { new?: unknown; old?: unknown; payload?: { new?: unknown; old?: unknown } };
  const novoRaw = p.new ?? p.payload?.new;
  const antigoRaw = p.old ?? p.payload?.old;
  return {
    novo: novoRaw && typeof novoRaw === "object" && !Array.isArray(novoRaw) ? (novoRaw as Record<string, unknown>) : null,
    antigo:
      antigoRaw && typeof antigoRaw === "object" && !Array.isArray(antigoRaw)
        ? (antigoRaw as Record<string, unknown>)
        : null,
  };
}

/** Título do sino por aviso — o `kind` é o mesmo nome, e é o que a entrega usa. */
const TITULO_DO_AVISO: Record<AvisoDeNegocio, string> = {
  lead_assigned: "Lead atribuído a você",
  lead_won: "Lead ganho",
  lead_lost: "Lead perdido",
};

export function useCrmAlerts(): void {
  const orgId = useActiveOrg()?.orgId ?? null;
  const user = useUser();
  /**
   * ⚠️ O HISTÓRICO VEM DAQUI, NÃO DO `old` DO REALTIME (issue #3040).
   *
   * Sem `REPLICA IDENTITY FULL` o UPDATE chega com `old = { id }` e só isso:
   * comparar com ele dizia que TODO evento mudou o responsável, e cada resposta
   * do vendedor (o `#2958` carimba `last_activity_at`) virava um "Lead atribuído
   * a você". O último estado visto por negócio mora no cliente — a decisão
   * inteira está em `./aviso-de-negocio.ts`, com o porquê.
   */
  const memorias = useRef(new Map<string, EstadoVisto>());

  const onLead = useCallback(
    (payload: unknown) => {
      const { novo, antigo } = sides(payload);
      if (!novo) return;
      const leadId = str(novo.id);
      if (!leadId) return;

      // O que já sabíamos deste negócio: a memória do próprio cliente; na falta
      // dela, o `old` — e só quando ele de fato carrega os campos (instalação
      // com REPLICA IDENTITY FULL). Sem nenhum dos dois o histórico é
      // desconhecido, e aí não se notifica nada.
      const anterior = memorias.current.get(leadId) ?? estadoDoAntigo(antigo);
      const estado = estadoDoNovo(novo);
      memorias.current.set(leadId, estado);

      const avisos = avisosDoNegocio(anterior, estado, user.id);
      if (avisos.length === 0) return;

      const title = str(novo.title) || "Lead";
      const pipelineId = str(novo.pipeline_id);
      const href = pipelineId ? `/app/pipelines/${pipelineId}` : "/app/kanban";

      for (const aviso of avisos) {
        entregarAviso({
          category: aviso,
          kind: aviso,
          title: TITULO_DO_AVISO[aviso],
          body: title,
          corpoSemPrevia: title,
          tag: leadId,
          href,
        });
      }
    },
    [user.id],
  );

  const onNote = useCallback(
    (payload: unknown) => {
      const { novo } = sides(payload);
      if (!novo) return;
      const author = str(novo.created_by_user_id);
      if (author === user.id) return;
      const body = str(novo.body) ?? "";
      if (
        !mencaoAtingeUsuario(body, {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
        })
      ) {
        return;
      }
      const conversationId = str(novo.conversation_id);
      entregarAviso({
        category: "mention",
        kind: "mention",
        title: "Você foi mencionado",
        // O sino é LIDO por gente: o token com o id vira `@Ana Lima` aqui,
        // nunca o contrário (o casamento já aconteceu logo acima, no cru).
        body: textoLegivelDeMencao(body),
        tag: conversationId ?? undefined,
        href: conversationId ? `/app/inbox?id=${conversationId}` : "/app/inbox",
      });
    },
    [user.id, user.email, user.full_name],
  );

  useRealtimeChannel({
    name: orgId ? `alerts-leads-${orgId}` : "alerts-leads-disabled",
    postgresChanges: orgId
      ? {
          event: "UPDATE",
          schema: "public",
          table: "crm_leads",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange: onLead,
    enabled: !!orgId,
  });

  useRealtimeChannel({
    name: orgId ? `alerts-notes-${orgId}` : "alerts-notes-disabled",
    postgresChanges: orgId
      ? {
          event: "INSERT",
          schema: "public",
          table: "conversation_notes",
          filter: `organization_id=eq.${orgId}`,
        }
      : undefined,
    onChange: onNote,
    enabled: !!orgId,
  });
}
