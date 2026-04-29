"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IncidentsTable,
  IncidentsTableSkeleton,
} from "@/components/admin/incidents/IncidentsTable";
import {
  useAdminIncidents,
  type AdminIncidentsFilters,
  type IncidentStatus,
  type IncidentSeverity,
} from "@/hooks/useAdminIncidents";

const STATUS_OPTIONS: { value: IncidentStatus; label: string }[] = [
  { value: "open", label: "Abertos" },
  { value: "acknowledged", label: "Reconhecidos" },
  { value: "resolved", label: "Resolvidos" },
];

const SEVERITY_OPTIONS: { value: IncidentSeverity; label: string }[] = [
  { value: "critical", label: "Crítico" },
  { value: "warning", label: "Atenção" },
  { value: "info", label: "Info" },
];

export function IncidentsClient() {
  const [filters, setFilters] = useState<AdminIncidentsFilters>({
    status: "open",
  });

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useAdminIncidents(filters);

  const rows = data?.pages.flatMap((p) => p.data ?? []) ?? [];
  const total = rows.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Incidentes</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isLoading
              ? "Carregando..."
              : `${total} incidente${total !== 1 ? "s" : ""}${hasNextPage ? "+" : ""}`}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select
          value={filters.status ?? "open"}
          onValueChange={(v) =>
            setFilters((f) => ({ ...f, status: v as IncidentStatus }))
          }
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.severity ?? "all"}
          onValueChange={(v) =>
            setFilters((f) => ({
              ...f,
              severity: v === "all" ? undefined : (v as IncidentSeverity),
            }))
          }
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Severidade" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas severidades</SelectItem>
            {SEVERITY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {(filters.severity ?? filters.tenant_id) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters((f) => ({ status: f.status }))}
          >
            Limpar filtros
          </Button>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <IncidentsTableSkeleton />
      ) : (
        <IncidentsTable
          data={rows}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
        />
      )}
    </div>
  );
}
