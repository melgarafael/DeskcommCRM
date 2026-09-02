"use client";
import Link from "next/link";
import { formatDistanceToNow, differenceInHours } from "date-fns";
import { pt as ptBR } from "date-fns/locale";
import { Badge } from "@/components/ui/badge";
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  return id.slice(0, 8);
}

function relativeDate(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });
  } catch {
    return iso;
  }
}

function countdownLabel(dueAt: string | null, status: AdminLgpdStatus): string {
  const terminal = new Set<AdminLgpdStatus>(["completed", "failed"]);
  if (terminal.has(status) || !dueAt) return "—";
  const now = new Date();
  const due = new Date(dueAt);
  const hours = differenceInHours(due, now);
  if (hours < 0) return `${Math.abs(hours)}h em atraso`;
  if (hours < 24) return `${hours}h restantes`;
  const days = Math.floor(hours / 24);
  return `${days}d restantes`;
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
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {["ID", "Tipo", "Tenant", "Recebido em", "Vence em", "Risco", "Status", ""].map(
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
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
      <p className="text-sm font-medium text-muted-foreground">
        Nenhuma solicitação encontrada
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Ajuste os filtros para ver solicitações.</p>
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
  if (data.length === 0) return <EmptyState />;

  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[90px]">ID</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead className="w-[160px]">Tenant</TableHead>
              <TableHead className="w-[130px]">Recebido em</TableHead>
              <TableHead className="w-[130px]">Vence em</TableHead>
              <TableHead className="w-[80px]">Risco</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
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
                    {TYPE_LABELS[row.request_type] ?? row.request_type}
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
                  {relativeDate(row.received_at)}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {countdownLabel(row.due_at, row.status)}
                </TableCell>
                <TableCell>
                  <Badge variant={RISK_VARIANT[row.risk_level]} className="text-[10px]">
                    {RISK_LABELS[row.risk_level]}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={STATUS_VARIANT[row.status]}
                    className="text-[10px]"
                  >
                    {STATUS_LABELS[row.status] ?? row.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    <Link href={`/admin/lgpd/requests/${row.id}`}>Ver</Link>
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
            {isFetchingNextPage ? "Carregando..." : "Carregar mais"}
          </Button>
        </div>
      )}
    </div>
  );
}
