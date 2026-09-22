"use client";
import { Warning } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import type { LgpdRequest } from "@/hooks/useLgpdRequests";

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

interface SlaBannerProps {
  requests: LgpdRequest[];
}

export function SlaBanner({ requests }: SlaBannerProps) {
  const t = useT();
  const active = requests.filter((r) => !TERMINAL_STATUSES.has(r.status));

  const critical = active.filter(
    (r) => r.sla_bucket === "overdue" || r.sla_bucket === "critical",
  );
  const warning = active.filter((r) => r.sla_bucket === "warning");

  if (critical.length > 0) {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-lg border border-error/40 bg-error-bg px-4 py-3 text-sm text-error-fg"
      >
        <Warning size={18} weight="fill" className="shrink-0 text-error-fg" aria-hidden />
        <span>
          <strong>{critical.length}</strong>{" "}
          {t(critical.length === 1 ? "solicitação crítica" : "solicitações críticas")} —{" "}
          {t("SLA vencido ou inferior a 2 dias. Ação imediata requerida.")}
        </span>
      </div>
    );
  }

  if (warning.length > 0) {
    return (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning-fg"
      >
        <Warning size={18} weight="fill" className="shrink-0 text-warning-fg" aria-hidden />
        <span>
          <strong>{warning.length}</strong>{" "}
          {t(warning.length === 1 ? "solicitação em alerta" : "solicitações em alerta")} —{" "}
          {t("mais de 50% do prazo consumido.")}
        </span>
      </div>
    );
  }

  return null;
}
