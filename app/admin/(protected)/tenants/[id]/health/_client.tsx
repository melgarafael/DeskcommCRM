"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { Skeleton } from "@/components/ui/skeleton";
import { useTenantHealth } from "@/hooks/useTenantHealth";
import { HealthGrid } from "@/components/admin/tenants/HealthGrid";
import { ArrowsClockwise } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TenantHealthClientProps {
  id: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantHealthClient({ id }: TenantHealthClientProps) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const { data, isLoading, isError, isFetching, dataUpdatedAt } = useTenantHealth(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data?.data) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center text-sm text-destructive">
        {t("Não foi possível carregar o status de saúde do tenant. Tente recarregar a página.")}
      </div>
    );
  }

  const lastChecked = dataUpdatedAt
    ? new Intl.DateTimeFormat(tagDoIdioma, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(dataUpdatedAt))
    : null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          {t("Status de Saúde")}
        </h2>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {isFetching && (
            <ArrowsClockwise size={13} className="animate-spin" aria-hidden />
          )}
          {lastChecked && <span>{t("Atualizado às")} {lastChecked}</span>}
        </div>
      </div>

      <HealthGrid health={data.data} />
    </div>
  );
}
