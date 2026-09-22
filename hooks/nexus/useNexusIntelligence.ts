"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";
import { useAtRiskLeads } from "@/hooks/leads/useAtRiskLeads";
import { useKnowledgeSources } from "@/hooks/ai/useKnowledgeSources";
import { useOrgMemory } from "@/hooks/ai/useOrgMemory";
import { useEvolution } from "@/hooks/ai/useEvolution";
import type { LinhaRadarLista } from "@/app/app/radar/_components/RecompraRadarList";
import { buildIntelligenceGraph, type NexusGraph, type NexusRadarRow } from "@/lib/nexus/graph";

/**
 * Dados da Inteligência: reusa os hooks canônicos (mesmas chaves de cache das
 * telas de origem) + radar-compras. Nenhum endpoint novo, nenhum dado inventado.
 */
function paraRadarRow(l: LinhaRadarLista): NexusRadarRow {
  return {
    contact_id: l.contact_id,
    nome: l.nome,
    cidade: l.cidade ?? null,
    uf: l.uf ?? null,
    situacao: l.situacao,
    dias_sem_compra: l.dias_sem_compra,
    atraso_dias: l.atraso_dias,
    ultima_compra: l.ultima_compra,
    faturamento_cents: l.faturamento_cents,
    ticket_medio_cents: l.ticket_medio_cents,
    intervalo_mediano_dias: l.intervalo_mediano_dias,
    qtd_pedidos: l.qtd_pedidos,
  };
}

function mesPassado(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

export interface NexusIntelligence {
  graph: NexusGraph;
  radarRows: NexusRadarRow[];
  totalRadar: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useNexusIntelligence(): NexusIntelligence {
  const t = useT();
  const [range] = useState(mesPassado);
  const radar = useQuery({
    queryKey: ["nexus", "radar"],
    queryFn: () =>
      apiClient
        .get<{ data: LinhaRadarLista[] }>("/api/v1/radar-compras?situacao=todas&limit=300")
        .then((r) => r.data ?? []),
    staleTime: 60_000,
  });
  const atRisk = useAtRiskLeads();
  const knowledge = useKnowledgeSources();
  const memory = useOrgMemory();
  const evolution = useEvolution(range);

  const graph = useMemo<NexusGraph>(() => {
    const radarRows = (radar.data ?? []).map(paraRadarRow);
    return buildIntelligenceGraph(
      {
        radar: radarRows,
        risks: (atRisk.data?.items ?? []).map((r) => ({
          id: r.id,
          title: r.title,
          contact_id: r.contact_id,
          contact_name: r.contact_name,
          risk: r.risk,
          hours_since_activity: r.hours_since_activity,
        })),
        knowledge: (knowledge.data ?? [])
          .filter((f) => f.is_active)
          .map((f) => ({
            id: f.id,
            name: f.name,
            status: f.last_index_status,
            chunks_count: f.chunks_count,
          })),
        memory: (memory.data?.entries ?? []).map((e) => ({
          id: e.id,
          title: e.title,
          source: e.source,
          status: e.status,
        })),
        evolution: evolution.data
          ? {
              cost_cents: evolution.data.outcome.cost_cents,
              messages_received: evolution.data.outcome.messages_received,
              handoff_rate: evolution.data.outcome.handoff_rate,
              proposals_applied: evolution.data.learned.proposals_applied,
            }
          : null,
      },
      t,
    );
  }, [radar.data, atRisk.data, knowledge.data, memory.data, evolution.data, t]);

  const radarRows = useMemo(() => (radar.data ?? []).map(paraRadarRow), [radar.data]);

  return {
    graph,
    radarRows,
    totalRadar: radar.data?.length ?? 0,
    isLoading:
      radar.isLoading ||
      atRisk.isLoading ||
      knowledge.isLoading ||
      memory.isLoading ||
      evolution.isLoading,
    isError:
      radar.isError || atRisk.isError || knowledge.isError || memory.isError || evolution.isError,
    refetch: () => {
      void radar.refetch();
      void atRisk.refetch();
      void knowledge.refetch();
      void memory.refetch();
      void evolution.refetch();
    },
  };
}
