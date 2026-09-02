"use client";
import { Badge } from "@/components/ui/badge";
import { Warning } from "@/lib/ui/icons";
import type {
  TenantOrganization,
  TenantCounts,
  TenantIntegrations,
} from "@/hooks/useTenantDetail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
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
  return (
    <div className={[
      "rounded-lg border p-4 flex flex-col gap-1",
      warning && value > 0 ? "border-amber-300 bg-amber-50/50 dark:border-amber-700 dark:bg-amber-950/20" : "bg-card",
    ].join(" ")}>
      <span className="text-2xl font-bold tabular-nums">{value.toLocaleString("pt-BR")}</span>
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
  integrations: TenantIntegrations;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantOverview({ organization, counts, integrations }: TenantOverviewProps) {
  const plan = (organization.settings as { plan?: string } | null)?.plan ?? "—";

  const nuvemshopStatus = integrations.nuvemshop_status;
  // Valor fora do vocabulário conhecido continua aparecendo cru de propósito:
  // esconder um estado que a tela não sabe nomear é pior que mostrá-lo.
  const nuvemshopLabel = nuvemshopStatus
    ? (NUVEMSHOP_LABEL[nuvemshopStatus] ?? nuvemshopStatus)
    : "Não integrado";
  const nuvemshopVariant = nuvemshopStatus
    ? (NUVEMSHOP_VARIANT[nuvemshopStatus] ?? "warning")
    : "neutral";

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

      {/* Integrations + WAHA */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border bg-card p-5">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Integrações
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
                label="Conectado em"
                value={formatDate(integrations.nuvemshop_connected_at)}
              />
            )}
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
            <InfoRow label="Invocações IA (30d)" value={counts.ai_invocations_30d.toLocaleString("pt-BR")} />
          </div>
        </div>
      </div>
    </div>
  );
}
