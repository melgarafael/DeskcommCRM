"use client";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
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
import { Warning } from "@/lib/ui/icons";
import type { AdminIncidentRow, IncidentSeverity, IncidentStatus } from "@/hooks/useAdminIncidents";

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

const SEVERITY_VARIANTS: Record<IncidentSeverity, "error" | "warning" | "info"> = {
  critical: "error",
  warning: "warning",
  info: "info",
};

const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  critical: "Crítico",
  warning: "Atenção",
  info: "Info",
};

const STATUS_VARIANTS: Record<IncidentStatus, "neutral" | "info" | "success"> = {
  open: "neutral",
  acknowledged: "info",
  resolved: "success",
};

const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: "Aberto",
  acknowledged: "Reconhecido",
  resolved: "Resolvido",
};

function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return (
    <Badge variant={SEVERITY_VARIANTS[severity]}>
      {SEVERITY_LABELS[severity]}
    </Badge>
  );
}

function StatusBadge({ status }: { status: IncidentStatus }) {
  return (
    <Badge variant={STATUS_VARIANTS[status]}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

function relativeDate(iso: string): string {
  return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: ptBR });
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function IncidentsTableSkeleton() {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[140px]">Quando</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead className="w-[160px]">Tenant</TableHead>
            <TableHead className="w-[110px]">Severidade</TableHead>
            <TableHead className="w-[120px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              {Array.from({ length: 6 }).map((_, j) => (
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

interface IncidentsTableProps {
  data: AdminIncidentRow[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

export function IncidentsTable({
  data,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: IncidentsTableProps) {
  if (data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-md border py-16 text-center text-muted-foreground">
        <Warning size={36} weight="duotone" className="opacity-40" aria-hidden />
        <p className="text-sm font-medium">Nenhum incidente encontrado</p>
        <p className="max-w-xs text-xs opacity-70">
          Ajuste os filtros para ver outros incidentes.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[140px]">Quando</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead className="w-[160px]">Tenant</TableHead>
              <TableHead className="w-[110px]">Severidade</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {relativeDate(row.created_at)}
                </TableCell>
                <TableCell className="font-mono text-xs">{row.type}</TableCell>
                <TableCell>
                  {row.tenant_name ? (
                    <span className="text-sm font-medium">{row.tenant_name}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={row.severity as IncidentSeverity} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.status as IncidentStatus} />
                </TableCell>
                <TableCell>
                  <Link
                    href={`/admin/incidents/${row.id}`}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    Ver
                  </Link>
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
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "Carregando..." : "Carregar mais"}
          </Button>
        </div>
      )}
    </div>
  );
}
