"use client";
import { AiReconciliation } from "@/components/admin/usage/AiReconciliation";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdminUsage, type UsageRange } from "@/hooks/useAdminUsage";
import { UsageCharts } from "@/components/admin/usage/UsageCharts";
import { UsageTable } from "@/components/admin/usage/UsageTable";
import { useT } from "@/hooks/i18n/useT";

const RANGE_OPTIONS: { value: UsageRange; label: string }[] = [
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
  { value: "90d", label: "Últimos 90 dias" },
];

export function UsageClient() {
  const t = useT();
  const [range, setRange] = useState<UsageRange>("30d");

  const { data, isLoading, isError } = useAdminUsage(range);

  const usageData = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Uso & Custo")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Consumo de mensagens, conversas e AI por tenant")}
          </p>
        </div>

        {/* Range selector */}
        <Select value={range} onValueChange={(v) => setRange(v as UsageRange)}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder={t("Período")} />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {t(opt.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <AiReconciliation />

      {/* Charts */}
      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-56 rounded-lg" />
          <Skeleton className="h-56 rounded-lg" />
          <Skeleton className="h-56 rounded-lg md:col-span-2" />
        </div>
      ) : isError || !usageData ? (
        <div className="flex items-center justify-center rounded-lg border py-12 text-sm text-muted-foreground">
          {t("Erro ao carregar dados de uso. Tente recarregar.")}
        </div>
      ) : (
        <>
          <UsageCharts series={usageData.series} />
          <UsageTable tenants={usageData.tenants} range={range} />
        </>
      )}
    </div>
  );
}
