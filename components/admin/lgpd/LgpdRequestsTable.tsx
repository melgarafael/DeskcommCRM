"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import Link from "next/link";
import { formatDistanceToNow, differenceInHours } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty";
import { Scales } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TenantBadge } from "@/components/admin/inbox/TenantBadge";
import type {
  AdminLgpdRequest,
  AdminLgpdRiskLevel,
  AdminLgpdStatus,
  AdminLgpdRequestType,
} from "@/hooks/useAdminLGPDRequests";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  return id.slice(0, 8);
}

function relativeDate(iso: string, locale: Locale): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: locale });
  } catch {
    return iso;
  }
}

function countdownLabel(
  dueAt: string | null,
  status: AdminLgpdStatus,
  t: (texto: string) => string = (texto) => texto,
): string {
  const terminal = new Set<AdminLgpdStatus>(["completed", "failed"]);
  if (terminal.has(status) || !dueAt) return "—";
  const now = new Date();
  const due = new Date(dueAt);
  const hours = differenceInHours(due, now);
  if (hours < 0) return `${Math.abs(hours)}h ${t("em atraso")}`;
  if (hours < 24) return `${hours}h ${t("restantes")}`;
  const days = Math.floor(hours / 24);
  return `${days}d ${t("restantes")}`;
}

const TYPE_LABELS: Record<AdminLgpdRequestType, string> = {
  redact: "Anonimização cliente",
  data_request: "Solicitação de dados",
  store_redact: "Anonimização tenant",
};

const STATUS_LABELS: Record<AdminLgpdStatus, string> = {
  received: "Recebido",
  processing: "Processando",
  completed: "Concluído",
  failed: "Falhou",
  pending_review: "Revisão",
};

const STATUS_VARIANT: Record<
  AdminLgpdStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  received: "secondary",
  processing: "default",
  completed: "outline",
  failed: "destructive",
  pending_review: "secondary",
};

const RISK_VARIANT: Record<
  AdminLgpdRiskLevel,
  "default" | "secondary" | "destructive" | "outline"
> = {
  expired: "destructive",
  at_risk: "destructive",
  warning: "secondary",
  ok: "outline",
};

const RISK_LABELS: Record<AdminLgpdRiskLevel, string> = {
  expired: "Vencido",
  at_risk: "Crítico",
  warning: "Alerta",
  ok: "OK",
};

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function LgpdRequestsTableSkeleton() {
  const t = useT();
  return (
    <div className="rounded-3xl border">
      <Table>
        <TableHeader>
          <TableRow>
            {["ID", t("Tipo"), "Tenant", t("Recebido em"), t("Vence em"), t("Risco"), t("Status"), ""].map(
              (h) => (
                <TableHead key={h}>{h}</TableHead>
              ),
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 8 }).map((_, i) => (
            <TableRow key={i}>
              {Array.from({ length: 8 }).map((__, j) => (
                <TableCell key={j}>
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

interface LgpdRequestsTableProps {
  data: AdminLgpdRequest[];
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
}

export function LgpdRequestsTable({
  data,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: LgpdRequestsTableProps) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  if (data.length === 0) {
    return (
      <EmptyState
        icon={Scales}
        headline="Nenhuma solicitação encontrada"
        subcopy="Ajuste os filtros para ver solicitações."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-3xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[90px]">ID</TableHead>
              <TableHead>{t("Tipo")}</TableHead>
              <TableHead className="w-[160px]">Tenant</TableHead>
              <TableHead className="w-[130px]">{t("Recebido em")}</TableHead>
              <TableHead className="w-[130px]">{t("Vence em")}</TableHead>
              <TableHead className="w-[80px]">{t("Risco")}</TableHead>
              <TableHead className="w-[100px]">{t("Status")}</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  #{shortId(row.id)}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs font-normal">
                    {t(TYPE_LABELS[row.request_type] ?? row.request_type)}
                  </Badge>
                </TableCell>
                <TableCell>
                  {row.tenant_name && row.tenant_slug ? (
                    <TenantBadge name={row.tenant_name} slug={row.tenant_slug} size="sm" />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {relativeDate(row.received_at, localeDaData)}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {countdownLabel(row.due_at, row.status, t)}
                </TableCell>
                <TableCell>
                  <Badge variant={RISK_VARIANT[row.risk_level]} className="text-[10px]">
                    {t(RISK_LABELS[row.risk_level])}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={STATUS_VARIANT[row.status]}
                    className="text-[10px]"
                  >
                    {t(STATUS_LABELS[row.status] ?? row.status)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    <Link href={`/admin/lgpd/requests/${row.id}`}>{t("Ver")}</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={onLoadMore}
          >
            {isFetchingNextPage ? t("Carregando...") : t("Carregar mais")}
          </Button>
        </div>
      )}
    </div>
  );
}
