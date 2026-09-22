"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { comoMoeda } from "@/lib/format/moeda";
import { useT } from "@/hooks/i18n/useT";
import { useAtRiskLeads } from "@/hooks/leads/useAtRiskLeads";
import { useProposals } from "@/hooks/leads/useProposals";
import { NexusAiBriefing, type NexusInsight } from "@/components/nexus-ui/ai/NexusAi";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Briefing de decisão: cada frase cita um número real lido agora
 * (radar, riscos, inativos, propostas da IA). Sem dado, sem frase.
 */
export function Briefing({ necessarioDia }: { necessarioDia: number | null }) {
  const t = useT();
  const atRisk = useAtRiskLeads();
  const proposals = useProposals();
  const inativos = useQuery({
    queryKey: ["nexus", "inativos"],
    queryFn: () =>
      apiClient
        .get<{ data: { id: string }[] }>("/api/v1/comercial/inativos?dias=60")
        .then((r) => r.data ?? []),
    staleTime: 60_000,
  });
  const radar = useQuery({
    queryKey: ["nexus", "radar-resumo"],
    queryFn: () =>
      apiClient
        .get<{ data: { situacao: string; atraso_dias: number }[] }>(
          "/api/v1/radar-compras?limit=500",
        )
        .then((r) => r.data ?? []),
    staleTime: 60_000,
  });

  const carregando =
    atRisk.isLoading || proposals.isLoading || inativos.isLoading || radar.isLoading;
  if (carregando) return <Skeleton className="h-36 w-full" />;

  const insights: NexusInsight[] = [];
  const emRisco = (radar.data ?? []).filter((r) => r.situacao === "em_risco").length;
  if (emRisco > 0) {
    insights.push({
      id: "risco",
      text: `${emRisco} ${t("cliente(s) em alto risco de perda — agir hoje evita churn.")}`,
      actionLabel: t("Ver Radar"),
      onAction: () => {
        window.location.href = "/app/radar";
      },
    });
  }

  const semProximo = atRisk.data?.total_sem_proximo_passo ?? 0;
  if (semProximo > 0) {
    insights.push({
      id: "proximo-passo",
      text: `${semProximo} ${t("demanda(s) aberta(s) sem próximo passo definido.")}`,
      actionLabel: t("Ver Radar"),
      onAction: () => {
        window.location.href = "/app/radar";
      },
    });
  }

  const parados = inativos.data?.length ?? 0;
  if (parados > 0) {
    insights.push({
      id: "inativos",
      text: `${parados} ${t("cliente(s) sem comprar há 60 dias ou mais.")}`,
      actionLabel: t("Recuperar"),
      onAction: () => {
        window.location.href = "/app/recuperacao";
      },
    });
  }

  const pendentes = proposals.data?.pending.length ?? 0;
  if (pendentes > 0) {
    insights.push({
      id: "propostas",
      text: `${pendentes} ${t("sugestão(ões) da IA aguardando sua decisão.")}`,
      actionLabel: t("Decidir"),
      onAction: () => {
        window.location.href = "/app/ai/inbox";
      },
    });
  }

  if (necessarioDia != null && necessarioDia > 0) {
    insights.push({
      id: "meta",
      text: `${t("Para bater a meta, vender")} ${comoMoeda(Math.round(necessarioDia), "BRL")} ${t("por dia útil.")}`,
      actionLabel: t("Criar pedido"),
      onAction: () => {
        window.location.href = "/app/pedidos/novo";
      },
    });
  }

  return (
    <NexusAiBriefing
      title={t("Resumo inteligente")}
      insights={insights.slice(0, 5)}
      emptyText={t("Nada pedindo atenção agora — operação em dia.")}
    />
  );
}
