"use client";
import { Card, CardContent } from "@/components/ui/card";
import { Buildings, Clock, WifiSlash, Scales, ChartBar } from "@/lib/ui/icons";
import type { DashboardKPIs } from "@/app/api/v1/admin/dashboard/kpis/route";
import type { ElementType } from "react";

interface KPICardProps {
  label: string;
  value: number;
  subtitle: string;
  Icon: ElementType;
  accent?: boolean;
  danger?: boolean;
}

function KPICard({ label, value, subtitle, Icon, accent, danger }: KPICardProps) {
  const iconColor = danger
    ? "text-red-500"
    : accent
      ? "text-amber-500"
      : "text-muted-foreground";

  const valueColor = danger
    ? "text-red-600"
    : accent
      ? "text-amber-600"
      : "text-foreground";

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {label}
            </p>
            <p className={`text-3xl font-bold tabular-nums ${valueColor}`}>{value}</p>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
          <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${iconColor}`} />
        </div>
      </CardContent>
    </Card>
  );
}

interface KPICardsProps {
  kpis: DashboardKPIs;
}

export function KPICards({ kpis }: KPICardsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
      <KPICard
        label="Tenants Ativos"
        value={kpis.tenants_active}
        subtitle="organizações ativas"
        Icon={Buildings}
      />
      <KPICard
        label="Pendentes >10min"
        value={kpis.conv_pending_10min}
        subtitle="conversas sem resposta"
        Icon={Clock}
        accent={kpis.conv_pending_10min > 0}
      />
      <KPICard
        label="Alertas WAHA"
        value={kpis.waha_ban_alerts}
        subtitle="sessões com problema"
        Icon={WifiSlash}
        accent={kpis.waha_ban_alerts > 0}
      />
      <KPICard
        label="Proteção de Dados em Risco"
        value={kpis.lgpd_at_risk}
        subtitle="requisições próximas do prazo"
        Icon={Scales}
        danger={kpis.lgpd_at_risk > 0}
      />
      {/* "acumulado", e não "no mês": o número vem de
          `ai_budgets.current_month_consumed_cents`, um contador que o gatilho
          soma sem olhar a data e que nada zera — ele é o gasto desde a
          instalação. O rótulo antigo dizia "uso ≥80%" sobre um teto MENSAL, e a
          divergência cresce com o tempo. Ver o comentário do cálculo em
          `app/api/v1/admin/dashboard/kpis/route.ts`. */}
      <KPICard
        label="Budgets IA"
        value={kpis.ai_budget_warnings}
        subtitle="tenants com gasto acumulado ≥80% do teto"
        Icon={ChartBar}
        accent={kpis.ai_budget_warnings > 0}
      />
    </div>
  );
}
