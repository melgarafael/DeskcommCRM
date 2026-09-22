"use client";

import { comoMoeda } from "@/lib/format/moeda";
import { useT } from "@/hooks/i18n/useT";
import { NexusEmptyState } from "@/components/nexus-ui/feedback/NexusEmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Funnel } from "@/lib/ui/icons";
import { useResumo360 } from "./_resumo360";

/**
 * Aba OPORTUNIDADES do 360°: negócios vinculados ao contato (fonte:
 * crm-summary, os 3 mais recentes — mesma fonte do painel do inbox).
 */
export function OportunidadesDoContato({ contactId }: { contactId: string }) {
  const t = useT();
  const { resumo, isLoading, isError } = useResumo360(contactId);

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError || !resumo) {
    return (
      <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted-foreground">
        {t("Não foi possível ler os negócios agora.")}
      </p>
    );
  }

  if (resumo.leads.length === 0) {
    return (
      <NexusEmptyState
        icon={Funnel}
        headline={t("Nenhum negócio vinculado")}
        subcopy={t("Quando um lead citar este cliente, ele aparece aqui.")}
        primary={{ label: t("Abrir Funis"), href: "/app/kanban" }}
      />
    );
  }

  return (
    <ul className="divide-y rounded-lg border border-border bg-surface">
      {resumo.leads.map((lead) => (
        <li key={lead.id} className="flex items-center gap-4 p-3 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-text">{lead.title}</p>
            <p className="text-xs text-muted-foreground">
              {lead.status === "open" ? t("Em aberto") : lead.status} · {t("atualizado em")}{" "}
              {lead.updated_at.slice(0, 10).split("-").reverse().join("/")}
            </p>
          </div>
          {lead.value_cents != null ? (
            <p className="font-medium text-text tabular-nums">
              {comoMoeda(lead.value_cents, "BRL")}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
