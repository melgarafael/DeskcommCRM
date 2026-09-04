"use client";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import {
  sourcesQueryKey,
  useKnowledgeSources,
  useReindexSource,
  type SourceRow,
} from "@/hooks/ai/useKnowledgeSources";
import {
  KnowledgeSourceCard,
  type KnowledgeSourceType,
} from "@/components/ai/KnowledgeSourceCard";

interface Props {
  agentId: string;
  initialSources: SourceRow[];
}

const SLOTS: KnowledgeSourceType[] = ["faq", "policy", "conversations", "catalog"];

function canonicalType(t: string): KnowledgeSourceType | "other" {
  if (t === "faq") return "faq";
  if (t === "policy") return "policy";
  if (t === "conversation" || t === "conversations") return "conversations";
  if (t === "catalog") return "catalog";
  return "other";
}

export function KnowledgeSourcesClient({ agentId, initialSources }: Props) {
  const qc = useQueryClient();
  const { data: sources } = useKnowledgeSources(agentId, { initialData: initialSources });
  const reindex = useReindexSource(agentId);

  const onChange = useCallback(() => {
    qc.invalidateQueries({ queryKey: sourcesQueryKey(agentId) });
  }, [agentId, qc]);

  // Pelo hook compartilhado: `.channel()` cru assina como ANÔNIMO (cookie de
  // sessão httpOnly) — recebe "ok" e nunca entrega. Aqui o efeito era a lista de
  // fontes não atualizar sozinha depois de uma reindexação.
  useRealtimeChannel({
    name: `ai-knowledge-sources-${agentId}`,
    postgresChanges: {
      event: "*",
      schema: "public",
      table: "ai_knowledge_sources",
      filter: `agent_id=eq.${agentId}`,
    },
    onChange,
  });

  const list = sources ?? [];

  const bySlot: Record<KnowledgeSourceType, SourceRow | undefined> = {
    faq: undefined,
    policy: undefined,
    conversations: undefined,
    catalog: undefined,
  };

  for (const s of list) {
    const t = canonicalType(s.source_type);
    if (t !== "other" && !bySlot[t]) {
      bySlot[t] = s;
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {SLOTS.map((slot) => {
        const source = bySlot[slot];
        const isReindexing =
          reindex.isPending && reindex.variables === source?.id;
        return (
          <KnowledgeSourceCard
            key={slot}
            type={slot}
            source={source ?? null}
            isReindexing={isReindexing}
            onReindex={source ? () => reindex.mutate(source.id) : undefined}
            agentId={agentId}
            onCriada={onChange}
          />
        );
      })}
    </div>
  );
}
