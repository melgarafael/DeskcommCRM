"use client";
import { Warning } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

interface SuspendedBannerProps {
  suspendedAt: string;
  reason?: string;
}

function formatRelativePtBr(
  isoDate: string,
  t: (texto: string) => string = (texto) => texto,
): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return t("hoje");
  if (diffDays === 1) return t("ontem");
  if (diffDays < 7) return `${t("há")} ${diffDays} ${t("dias")}`;
  if (diffDays < 30) {
    const n = Math.floor(diffDays / 7);
    return `${t("há")} ${n} ${n > 1 ? t("semanas") : t("semana")}`;
  }
  if (diffDays < 365) {
    const n = Math.floor(diffDays / 30);
    return `${t("há")} ${n} ${n > 1 ? t("meses") : t("mês")}`;
  }
  const n = Math.floor(diffDays / 365);
  return `${t("há")} ${n} ${n > 1 ? t("anos") : t("ano")}`;
}

export function SuspendedBanner({ suspendedAt, reason }: SuspendedBannerProps) {
  const t = useT();
  return (
    <div
      role="region"
      aria-label={t("Tenant Suspenso")}
      className="sticky top-0 z-10 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-bg px-4 py-3 text-warning-fg"
    >
      <Warning size={18} weight="fill" className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
      <p className="text-sm">
        <span className="font-semibold">{t("Tenant suspenso")}</span>{" "}
        {formatRelativePtBr(suspendedAt, t)}.{" "}
        <span>
          {reason ?? t("Sem razão registrada.")}
        </span>
      </p>
    </div>
  );
}
