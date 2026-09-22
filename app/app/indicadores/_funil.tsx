"use client";

import { useAttendantMetrics } from "@/hooks/metrics/useAttendantMetrics";
import { useT } from "@/hooks/i18n/useT";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

/**
 * Pipeline de atendimento (30 dias): estágios reais do funil por atendente,
 * com ganhos e perdas. Rótulo honesto — é o funil de atendimento, não promessa
 * de "leads → oportunidades → pedidos".
 */
export function Funil() {
  const t = useT();
  const { data: resposta, isLoading, isError, refetch } = useAttendantMetrics(null);
  const data = resposta?.data;

  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (isError || !data) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4 text-sm shadow-xs">
        <p className="font-semibold text-text">{t("Funil de atendimento")}</p>
        <p className="mt-1 text-muted-foreground">{t("Não foi possível ler o funil agora.")}</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => void refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  const ganhos = data.attendants.reduce((acc, a) => acc + a.won, 0);
  const perdas = data.attendants.reduce((acc, a) => acc + a.lost, 0);

  return (
    <section
      aria-label={t("Funil de atendimento")}
      className="rounded-lg border border-border bg-surface p-4 shadow-xs"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-text">{t("Funil de atendimento")}</h2>
        <p className="text-xs text-muted-foreground">{t("últimos 30 dias")}</p>
      </div>
      {data.funnel.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{t("Sem movimento no período.")}</p>
      ) : (
        <ol className="mt-3 flex items-stretch gap-1" aria-label={t("Estágios")}>
          {data.funnel.map((estagio) => {
            const max = Math.max(...data.funnel.map((f) => f.count), 1);
            return (
              <li
                key={estagio.stage_id}
                className="min-w-0 flex-1"
                title={`${estagio.stage_name}: ${estagio.count}`}
              >
                <div
                  className="rounded-md bg-accent-soft"
                  style={{ height: `${Math.max(8, Math.round((estagio.count / max) * 56))}px` }}
                />
                <p className="mt-1 truncate text-[11px] text-muted-foreground">
                  {estagio.stage_name}
                </p>
                <p className="text-sm font-semibold text-text tabular-nums">{estagio.count}</p>
              </li>
            );
          })}
        </ol>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        <span className="font-medium text-text">
          {ganhos} {t("ganhos")}
        </span>{" "}
        · {perdas} {t("perdidos")}
      </p>
    </section>
  );
}
