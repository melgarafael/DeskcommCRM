"use client";
import Link from "next/link";
import { Warning } from "@/lib/ui/icons";
import type { AdminLgpdRequest } from "@/hooks/useAdminLGPDRequests";
import { useT } from "@/hooks/i18n/useT";

interface LgpdRiskBannerProps {
  requests: AdminLgpdRequest[];
}

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export function LgpdRiskBanner({ requests }: LgpdRiskBannerProps) {
  const t = useT();
  const active = requests.filter((r) => !TERMINAL_STATUSES.has(r.status));
  const critical = active.filter(
    (r) => r.risk_level === "expired" || r.risk_level === "at_risk",
  );

  if (critical.length === 0) return null;

  const count = critical.length;

  return (
    <div
      role="alert"
      className="sticky top-0 z-10 flex items-center justify-between gap-4 rounded-lg border border-error/40 bg-error-bg px-4 py-3 text-sm text-error-fg"
    >
      <div className="flex items-center gap-3">
        <Warning
          size={18}
          weight="fill"
          className="shrink-0 text-error-fg"
          aria-hidden
        />
        <span>
          <strong>{count}</strong>{" "}
          {count === 1
            ? t("solicitação vencendo em menos de 24h ou já vencida")
            : t("solicitações vencendo em menos de 24h ou já vencidas")}
          {" — "}
          {t("ação imediata requerida.")}
        </span>
      </div>
      <Link
        href="/admin/lgpd?risk_level=expired"
        className="shrink-0 text-xs font-medium underline underline-offset-2 hover:opacity-80"
      >
        {t("Ver detalhes")}
      </Link>
    </div>
  );
}
