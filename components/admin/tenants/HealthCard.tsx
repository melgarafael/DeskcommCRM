"use client";

import type { ReactNode } from "react";
import type { HealthStatus } from "@/app/api/v1/admin/tenants/[id]/health/route";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthCardDetail {
  label: string;
  value: ReactNode;
}

export interface HealthCardProps {
  title: string;
  status: HealthStatus;
  icon: ReactNode;
  primaryValue: ReactNode;
  details?: HealthCardDetail[];
  lastUpdated?: string;
}

// ---------------------------------------------------------------------------
// Status palette
// ---------------------------------------------------------------------------

const STATUS_BORDER: Record<HealthStatus, string> = {
  ok: "border-emerald-500/60 dark:border-emerald-600/50",
  warning: "border-amber-400/70 dark:border-amber-500/50",
  critical: "border-red-500/70 dark:border-red-600/60",
};

const STATUS_BADGE_BG: Record<HealthStatus, string> = {
  ok: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  critical: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400",
};

const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: "OK",
  warning: "Atenção",
  critical: "Crítico",
};

const STATUS_DOT: Record<HealthStatus, string> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-400",
  critical: "bg-red-500",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HealthCard({
  title,
  status,
  icon,
  primaryValue,
  details,
  lastUpdated,
}: HealthCardProps) {
  const t = useT();
  const isCritical = status === "critical";

  return (
    <div
      className={[
        "rounded-xl border-2 bg-card p-5 flex flex-col gap-4 transition-colors",
        STATUS_BORDER[status],
      ].join(" ")}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="w-5 h-5 shrink-0" aria-hidden>
            {icon}
          </span>
          <span className="text-xs font-semibold uppercase tracking-wider leading-none">
            {title}
          </span>
        </div>

        {/* Status badge + pulse */}
        <div className="flex items-center gap-1.5">
          {isCritical && (
            <span className="relative flex h-2 w-2" aria-hidden>
              <span
                className={[
                  "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                  STATUS_DOT[status],
                ].join(" ")}
              />
              <span
                className={[
                  "relative inline-flex rounded-full h-2 w-2",
                  STATUS_DOT[status],
                ].join(" ")}
              />
            </span>
          )}
          <span
            className={[
              "rounded-full px-2 py-0.5 text-xs font-medium",
              STATUS_BADGE_BG[status],
            ].join(" ")}
          >
            {t(STATUS_LABEL[status])}
          </span>
        </div>
      </div>

      {/* Primary value */}
      <div className="text-2xl font-bold tracking-tight leading-none">
        {primaryValue}
      </div>

      {/* Details */}
      {details && details.length > 0 && (
        <div className="space-y-1.5 border-t pt-3">
          {details.map((d) => (
            <div
              key={d.label}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="text-muted-foreground text-xs whitespace-nowrap">
                {d.label}
              </span>
              <span className="font-medium text-right text-xs">{d.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Last updated */}
      {lastUpdated && (
        <p className="text-[11px] text-muted-foreground mt-auto">
          {lastUpdated}
        </p>
      )}
    </div>
  );
}
