"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty";
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
import { useT } from "@/hooks/i18n/useT";

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
  const t = useT();
  return (
    <Badge variant={SEVERITY_VARIANTS[severity]}>
      {t(SEVERITY_LABELS[severity])}
    </Badge>
  );
}

function StatusBadge({ status }: { status: IncidentStatus }) {
  const t = useT();
  return (
    <Badge variant={STATUS_VARIANTS[status]}>
      {t(STATUS_LABELS[status])}
    </Badge>
  );
}

function relativeDate(iso: string, locale: Locale): string {
  // date-fns lança RangeError em data inválida, e isso derrubava a página
  // inteira no error boundary — o usuário via só um digest no lugar da tabela.
  // Uma célula com "—" é melhor do que perder a tela por um timestamp ausente.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true, locale: locale });
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function IncidentsTableSkeleton() {
  const t = useT();
  return (
    <div className="rounded-3xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[140px]">{t("Quando")}</TableHead>
            <TableHead>{t("Tipo")}</TableHead>
            <TableHead className="w-[160px]">Tenant</TableHead>
            <TableHead className="w-[110px]">{t("Severidade")}</TableHead>
            <TableHead className="w-[120px]">{t("Status")}</TableHead>
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
  const localeDaData = useLocaleDeData();
  const t = useT();
  if (data.length === 0) {
    return (
      <EmptyState
        icon={Warning}
        headline="Nenhum incidente encontrado"
        subcopy="Ajuste os filtros para ver outros incidentes."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[140px]">{t("Quando")}</TableHead>
              <TableHead>{t("Tipo")}</TableHead>
              <TableHead className="w-[160px]">Tenant</TableHead>
              <TableHead className="w-[110px]">{t("Severidade")}</TableHead>
              <TableHead className="w-[120px]">{t("Status")}</TableHead>
              <TableHead className="w-[60px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {relativeDate(row.created_at, localeDaData)}
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
                    {t("Ver")}
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
            {isFetchingNextPage ? t("Carregando...") : t("Carregar mais")}
          </Button>
        </div>
      )}
    </div>
  );
}
