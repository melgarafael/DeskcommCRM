"use client";

import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { Badge } from "@/components/ui/badge";
import { Warning } from "@/lib/ui/icons";
import type {
  TenantOrganization,
  TenantCounts,
  TenantIntegrations,
} from "@/hooks/useTenantDetail";
import { useT } from "@/hooks/i18n/useT";

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

// Vocabulário real de `tenant_integrations.status` (CHECK no schema). A tela
// comparava com "active", que não existe nele: a integração saudável escrita
// pelo callback do OAuth ('healthy') caía no ramo final e a tela imprimia a
// string crua do banco.
//
// Exportados para o teste conferir a COBERTURA contra o CHECK do
// `supabase/baseline.sql` (TenantOverview.test.tsx): status novo que uma
// migration acrescente ao banco sem entrar nestes mapas volta a vazar cru para
// a tela, e é isso que o teste reprova.
export const NUVEMSHOP_LABEL: Record<string, string> = {
  connecting: "Conectando",
  healthy: "Conectado",
  token_expired: "Token expirado",
  scope_missing: "Permissão faltando",
  disconnected: "Desconectado",
  rate_limited: "Limitado (rate limit)",
  error: "Com erro",
};

export const NUVEMSHOP_VARIANT: Record<string, "success" | "warning" | "error" | "neutral"> = {
  connecting: "neutral",
  healthy: "success",
  token_expired: "error",
  scope_missing: "error",
  disconnected: "warning",
  rate_limited: "warning",
  error: "error",
};

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b last:border-0">
      <span className="text-sm text-muted-foreground whitespace-nowrap">{label}</span>
      <span className="text-sm font-medium text-right">{value ?? "—"}</span>
    </div>
  );
}

function StatCard({ label, value, warning }: { label: string; value: number; warning?: boolean }) {
  const t = useT();
  return (
    <div className={[
      "rounded-2xl border p-4 flex flex-col gap-1",
      warning && value > 0 ? "border-warning/40 bg-warning-bg" : "bg-card",
    ].join(" ")}>
      <span className="text-2xl font-bold tabular-nums text-text">{value.toLocaleString("pt-BR")}</span>
      <span className="text-xs text-muted-foreground leading-tight">{label}</span>
      {warning && value > 0 && (
        <Warning size={14} weight="fill" className="text-warning-fg mt-0.5" aria-label={t("Atenção")} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TenantOverviewProps {
  organization: TenantOrganization;
  counts: TenantCounts;
  integrations: TenantIntegrations;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantOverview({ organization, counts, integrations }: TenantOverviewProps) {
  const tagDoIdioma = useTagDeIdioma();
  const t = useT();
  const plan = (organization.settings as { plan?: string } | null)?.plan ?? "—";

  const nuvemshopStatus = integrations.nuvemshop_status;
  // Valor fora do vocabulário conhecido continua aparecendo cru de propósito:
  // esconder um estado que a tela não sabe nomear é pior que mostrá-lo.
  const nuvemshopLabel = nuvemshopStatus
    ? t(NUVEMSHOP_LABEL[nuvemshopStatus] ?? nuvemshopStatus)
    : t("Não integrado");
  const nuvemshopVariant = nuvemshopStatus
    ? (NUVEMSHOP_VARIANT[nuvemshopStatus] ?? "warning")
    : "neutral";

  return (
    <div className="space-y-6">
      {/* Info card */}
      <div className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          {t("Informações")}
        </h2>
        <div>
          <InfoRow label={t("Plano")} value={<Badge variant="neutral" className="capitalize">{plan}</Badge>} />
          <InfoRow label={t("Razão social")} value={organization.legal_name} />
          <InfoRow label="CNPJ" value={organization.cnpj} />
          <InfoRow label={t("Onboarding concluído")} value={formatDate(organization.onboarded_at, tagDoIdioma)} />
          <InfoRow label={t("Criado em")} value={formatDate(organization.created_at, tagDoIdioma)} />
          {organization.suspended_at && (
            <InfoRow label={t("Suspenso em")} value={formatDate(organization.suspended_at, tagDoIdioma)} />
          )}
        </div>
      </div>

      {/* Counts row */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          {t("Volumes")}
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label={t("Usuários")} value={counts.user_count} />
          <StatCard label={t("Conversas")} value={counts.conversations_count} />
          <StatCard label={t("Mensagens")} value={counts.messages_count} />
          <StatCard label={t("Leads")} value={counts.leads_count} />
          <StatCard label={t("Pedidos")} value={counts.orders_count} />
        </div>
      </div>

      {/* Integrations + WAHA */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {t("Integrações")}
          </h2>
          <div>
            <InfoRow
              label="Nuvemshop"
              value={
                <Badge variant={nuvemshopVariant}>{nuvemshopLabel}</Badge>
              }
            />
            {integrations.nuvemshop_connected_at && (
              <InfoRow
                label={t("Conectado em")}
                value={formatDate(integrations.nuvemshop_connected_at, tagDoIdioma)}
              />
            )}
            <InfoRow label="WAHA sessions" value={counts.waha_sessions_count} />
          </div>
        </div>

        {/* LGPD + AI */}
        <div className="rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {t("Compliance & IA")}
          </h2>
          <div>
            <InfoRow
              label={t("Solicitações LGPD pendentes")}
              value={
                <span className="flex items-center gap-1.5">
                  <span className={counts.lgpd_requests_pending > 0 ? "text-amber-600 font-semibold" : ""}>
                    {counts.lgpd_requests_pending}
                  </span>
                  {counts.lgpd_requests_pending > 0 && (
                    <Warning size={14} weight="fill" className="text-amber-500" aria-label={t("Pendências LGPD")} />
                  )}
                </span>
              }
            />
            <InfoRow label={t("Invocações IA (30d)")} value={counts.ai_invocations_30d.toLocaleString("pt-BR")} />
          </div>
        </div>
      </div>
    </div>
  );
}
