"use client";

import { ROTULO_RECOMPRA } from "@/lib/comercial/radar-compras";
import { comoMoeda } from "@/lib/format/moeda";
import { useT } from "@/hooks/i18n/useT";
import { NexusAiBriefing, type NexusInsight } from "@/components/nexus-ui/ai/NexusAi";
import { Skeleton } from "@/components/ui/skeleton";
import { useResumo360 } from "./_resumo360";

/**
 * Aba INTELIGÊNCIA do 360°: situação de recompra calculada dos pedidos reais
 * + negócios e demandas em aberto. Cada frase cita a fonte (números do
 * histórico, não palpite).
 */
export function InteligenciaDoContato({ contactId }: { contactId: string }) {
  const t = useT();
  const { resumo, isLoading, isError } = useResumo360(contactId);

  if (isLoading) return <Skeleton className="h-36 w-full" />;
  if (isError || !resumo) {
    return (
      <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted-foreground">
        {t("Não foi possível calcular a inteligência agora.")}
      </p>
    );
  }

  const insights: NexusInsight[] = [];
  const h = resumo.historico;

  if (h) {
    if (h.situacao !== "ok") {
      insights.push({
        id: "situacao",
        text: `${ROTULO_RECOMPRA[h.situacao]}: ${t("há")} ${h.dias_sem_compra} ${t("dias sem compra")}. ${t("Última")}: ${h.ultima_compra}, ${t("ticket médio")}: ${comoMoeda(h.ticket_medio_cents, "BRL")}.`,
        actionLabel: t("Ver pedidos"),
        onAction: () => {
          document.querySelector<HTMLElement>('[data-tab="compras"]')?.click();
        },
      });
    } else {
      insights.push({
        id: "em-dia",
        text: `${t("Cliente em dia")}: ${t("comprou há")} ${h.dias_sem_compra} ${t("dias")}, ${h.qtd_pedidos} ${t("pedido(s)")}, ${comoMoeda(h.faturamento_cents, "BRL")} ${t("acumulado")}.`,
      });
    }
    if (h.intervalo_mediano_dias != null && h.dias_sem_compra > h.intervalo_mediano_dias) {
      insights.push({
        id: "recompra",
        text: `${t("Passou do intervalo mediano de compra")} (${h.intervalo_mediano_dias} ${t("dias")}) — ${t("boa hora para sugerir recompra")}.`,
        actionLabel: t("Criar pedido"),
        onAction: () => {
          window.location.href = "/app/pedidos/novo";
        },
      });
    }
  }

  if (resumo.leadsAbertos > 0) {
    insights.push({
      id: "negocios",
      text: `${resumo.leadsAbertos} ${t("negócio(s) em aberto vinculado(s) a este cliente.")}`,
      actionLabel: t("Ver oportunidades"),
      onAction: () => {
        document.querySelector<HTMLElement>('[data-tab="oportunidades"]')?.click();
      },
    });
  }

  if (resumo.demandas.length > 0) {
    const semPasso = resumo.demandas.filter((d) => !d.proximo_passo).length;
    insights.push({
      id: "demandas",
      text: `${resumo.demandas.length} ${t("demanda(s) aberta(s)")}${semPasso > 0 ? `, ${semPasso} ${t("sem próximo passo")}` : ""}.`,
    });
  }

  return (
    <NexusAiBriefing
      title={t("Inteligência do cliente")}
      insights={insights}
      emptyText={t("Sem sinais relevantes — cliente novo ou sem movimento.")}
    />
  );
}
