"use client";

import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Skeletons padronizados (shape-aware). Proibido `<p>Carregando…` — usar
 * estes presets ou `NexusLoading` para espera curta sem forma conhecida.
 */
export function NexusTableSkeleton({
  rows = 6,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("Carregando dados")}
      className={cn("space-y-2 rounded-lg border border-border bg-surface p-4", className)}
    >
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-10 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function NexusCardsSkeleton({
  count = 3,
  className,
}: {
  count?: number;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      role="status"
      aria-label={t("Carregando dados")}
      className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-3", className)}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function NexusPageSkeleton({ className }: { className?: string }) {
  const t = useT();
  return (
    <div role="status" aria-label={t("Carregando página")} className={cn("space-y-4", className)}>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96" />
      <NexusTableSkeleton />
    </div>
  );
}
