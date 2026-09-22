"use client";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { KPICards } from "@/components/admin/dashboard/KPICards";
import { AlertsBanner } from "@/components/admin/dashboard/AlertsBanner";
import { useAdminDashboardKPIs } from "@/hooks/useAdminDashboardKPIs";
import { useAlertsRealtime } from "@/hooks/useAlertsRealtime";
import { useT } from "@/hooks/i18n/useT";

function KPISkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="pt-6 space-y-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AlertsSkeleton() {
  return (
    <Card>
      <CardContent className="py-4 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

export function DashboardClient() {
  const t = useT();
  const { data, isLoading } = useAdminDashboardKPIs();
  useAlertsRealtime();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium text-text tracking-tight">{t("Dashboard")}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t("Visão cross-tenant — atualiza a cada 30 segundos.")}
        </p>
      </div>

      {isLoading || !data ? (
        <>
          <KPISkeleton />
          <AlertsSkeleton />
        </>
      ) : (
        <>
          <KPICards kpis={data} />
          <AlertsBanner alerts={data.alerts} />
        </>
      )}
    </div>
  );
}
