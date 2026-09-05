"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

import { HealthCard } from "./HealthCard";
import {
  WifiHigh,
  Storefront,
  Brain,
  ClipboardText,
} from "@/lib/ui/icons";
import type { TenantHealthResponse } from "@/app/api/v1/admin/tenants/[id]/health/route";
import { useT } from "@/hooks/i18n/useT";
import { formatCentsUSD } from "@/lib/money";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null, idioma: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(idioma, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatLag(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${Math.round(seconds / 3600)}h`;
}

/** O teto vincula esta organização? É o que separa "100%" de "100% e parou". */
const MODO_LABEL: Record<TenantHealthResponse["ai"]["enforcement_mode"], string> = {
  off: "Não aplicado",
  avisar: "Só avisa",
  bloquear: "Para a IA no limite",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface HealthGridProps {
  health: TenantHealthResponse;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HealthGrid({ health }: HealthGridProps) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const { waha, nuvemshop, ai, audit } = health;

  // WAHA card
  // Vocabulário real de channel_sessions.status: STARTING/SCAN_QR_CODE/WORKING/
  // STOPPED/FAILED. "CONNECTED" nunca chegava aqui — o CHECK do schema o proíbe.
  const wahaConnected = waha.sessions.filter((s) => s.status === "WORKING").length;
  const wahaPrimary =
    waha.sessions.length === 0
      ? t("Sem sessões")
      : `${wahaConnected}/${waha.sessions.length} ${
          waha.sessions.length !== 1 ? t("conectadas") : t("conectada")
        }`;

  const wahaDetails = waha.sessions.slice(0, 4).map((s) => ({
    label: s.waha_session_name ?? s.id.slice(0, 8),
    value: s.status ?? "—",
  }));

  // Nuvemshop card
  const nuPrimary = nuvemshop.connected ? t("Conectado") : t("Não conectado");
  const nuDetails = [
    { label: t("Última sync"), value: formatDate(nuvemshop.last_synced_at, tagDoIdioma) },
    ...(nuvemshop.days_until_expiry !== null
      ? [{ label: t("Expira em"), value: `${nuvemshop.days_until_expiry}d` }]
      : []),
    ...(nuvemshop.expires_at
      ? [{ label: t("Token expira"), value: formatDate(nuvemshop.expires_at, tagDoIdioma) }]
      : []),
  ];

  // AI budget card
  const aiPrimary =
    ai.percent_used !== null ? `${ai.percent_used}% ${t("usado")}` : t("Sem orçamento");
  const aiDetails = [
    { label: t("Consumido"), value: formatCentsUSD(ai.consumed_cents) },
    {
      label: t("Orçamento"),
      value: ai.budget_cents ? formatCentsUSD(ai.budget_cents) : t("Ilimitado"),
    },
    { label: t("Limite"), value: t(MODO_LABEL[ai.enforcement_mode]) },
  ];

  // Audit lag card
  const auditPrimary = formatLag(audit.lag_seconds);
  const auditDetails = [
    { label: t("Último evento"), value: formatDate(audit.last_at, tagDoIdioma) },
    {
      label: "Lag",
      value: audit.lag_seconds !== null ? formatLag(audit.lag_seconds) : "—",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <HealthCard
        title="WAHA"
        status={waha.overall_status}
        icon={<WifiHigh size={18} aria-hidden />}
        primaryValue={wahaPrimary}
        details={wahaDetails}
      />

      <HealthCard
        title="Nuvemshop"
        status={nuvemshop.status}
        icon={<Storefront size={18} aria-hidden />}
        primaryValue={nuPrimary}
        details={nuDetails}
      />

      <HealthCard
        title={t("Orçamento IA")}
        status={ai.status}
        icon={<Brain size={18} aria-hidden />}
        primaryValue={aiPrimary}
        details={aiDetails}
      />

      <HealthCard
        title="Audit Lag"
        status={audit.status}
        icon={<ClipboardText size={18} aria-hidden />}
        primaryValue={auditPrimary}
        details={auditDetails}
      />
    </div>
  );
}
