"use client";

import { useCallback } from "react";

import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
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

export function useCrmAlerts(): void {
  const orgId = useActiveOrg()?.orgId ?? null;
  const user = useUser();

  const onLead = useCallback(
    (payload: unknown) => {
      const { novo, antigo } = sides(payload);
      if (!novo) return;
      const title = str(novo.title) || "Lead";
      const pipelineId = str(novo.pipeline_id);
      const href = pipelineId ? `/app/pipelines/${pipelineId}` : "/app/kanban";
      const owner = str(novo.owner_user_id);
      const ownerAntes = str(antigo?.owner_user_id);
      const status = str(novo.status);
      const statusAntes = str(antigo?.status);

      if (owner && owner === user.id && owner !== ownerAntes) {
        entregarAviso({
          category: "lead_assigned",
          kind: "lead_assigned",
          title: "Lead atribuído a você",
          body: title,
          tag: str(novo.id) ?? undefined,
          href,
        });
      }
      if (owner === user.id && status === "won" && statusAntes !== "won") {
        entregarAviso({
          category: "lead_won",
          kind: "lead_won",
          title: "Lead ganho",
          body: title,
          tag: str(novo.id) ?? undefined,
          href,
        });
      }
      if (owner === user.id && status === "lost" && statusAntes !== "lost") {
        entregarAviso({
          category: "lead_lost",
          kind: "lead_lost",
          title: "Lead perdido",
          body: title,
          tag: str(novo.id) ?? undefined,
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
