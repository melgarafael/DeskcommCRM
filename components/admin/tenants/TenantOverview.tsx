"use client";
import { Badge } from "@/components/ui/badge";
import { Warning } from "@/lib/ui/icons";
import type { TenantOrganization, TenantCounts } from "@/hooks/useTenantDetail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b last:border-0">
      <span className="text-sm text-muted-foreground whitespace-nowrap">{label}</span>
      <span className="text-sm font-medium text-right">{value ?? "—"}</span>
    </div>
  );
}

function StatCard({ label, value, warning }: { label: string; value: number; warning?: boolean }) {
  return (
    <div className={[
      "rounded-lg border p-4 flex flex-col gap-1",
      warning && value > 0 ? "border-amber-300 bg-amber-50/50 dark:border-amber-700 dark:bg-amber-950/20" : "bg-card",
    ].join(" ")}>
      <span className="text-2xl font-bold tabular-nums">{value.toLocaleString("pt-PT")}</span>
      <span className="text-xs text-muted-foreground leading-tight">{label}</span>
      {warning && value > 0 && (
        <Warning size={14} weight="fill" className="text-amber-500 mt-0.5" aria-label="Atenção" />
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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantOverview({ organization, counts }: TenantOverviewProps) {
  const plan = (organization.settings as { plan?: string } | null)?.plan ?? "—";

  return (
    <div className="space-y-6">
      {/* Info card */}
      <div className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Informações
        </h2>
        <div>
          <InfoRow label="Plano" value={<Badge variant="neutral" className="capitalize">{plan}</Badge>} />
          <InfoRow label="Razão social" value={organization.legal_name} />
          <InfoRow label="NUIT" value={organization.nuit} />
          <InfoRow label="Onboarding concluído" value={formatDate(organization.onboarded_at)} />
          <InfoRow label="Criado em" value={formatDate(organization.created_at)} />
          {organization.suspended_at && (
            <InfoRow label="Suspenso em" value={formatDate(organization.suspended_at)} />
          )}
        </div>
      </div>

      {/* Counts row */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Volumes
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Usuários" value={counts.user_count} />
          <StatCard label="Conversas" value={counts.conversations_count} />
          <StatCard label="Mensagens" value={counts.messages_count} />
          <StatCard label="Leads" value={counts.leads_count} />
          <StatCard label="Pedidos" value={counts.orders_count} />
        </div>
      </div>

      {/* Canais + WAHA */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Canais
          </h2>
          <div>
            <InfoRow label="WAHA sessions" value={counts.waha_sessions_count} />
          </div>
        </div>

        {/* LGPD + AI */}
        <div className="rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Compliance & IA
          </h2>
          <div>
            <InfoRow
              label="Solicitações LGPD pendentes"
              value={
                <span className="flex items-center gap-1.5">
                  <span className={counts.lgpd_requests_pending > 0 ? "text-amber-600 font-semibold" : ""}>
                    {counts.lgpd_requests_pending}
                  </span>
                  {counts.lgpd_requests_pending > 0 && (
                    <Warning size={14} weight="fill" className="text-amber-500" aria-label="Pendências LGPD" />
                  )}
                </span>
              }
            />
            <InfoRow label="Invocações IA (30d)" value={counts.ai_invocations_30d.toLocaleString("pt-PT")} />
          </div>
        </div>
      </div>
    </div>
  );
}
