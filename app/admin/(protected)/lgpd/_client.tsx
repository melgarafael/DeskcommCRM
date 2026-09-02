"use client";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAdminLGPDRequests,
  type AdminLgpdFilters,
  type AdminLgpdRiskLevel,
  type AdminLgpdStatus,
  type AdminLgpdRequestType,
} from "@/hooks/useAdminLGPDRequests";
import { LgpdRiskBanner } from "@/components/admin/lgpd/LgpdRiskBanner";
import {
  LgpdRequestsTable,
  LgpdRequestsTableSkeleton,
} from "@/components/admin/lgpd/LgpdRequestsTable";

const NONE = "__none__";

export function LgpdAdminClient() {
  const [filters, setFilters] = useState<AdminLgpdFilters>({});

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useAdminLGPDRequests(filters);

  const rows = data?.pages.flatMap((p) => p.data ?? []) ?? [];
  const total = rows.length;

  // For the risk banner, fetch the first page without filters to count expired/at_risk
  const { data: bannerData } = useAdminLGPDRequests({});
  const bannerRows = bannerData?.pages.flatMap((p) => p.data ?? []) ?? [];

  function setStatus(val: string) {
    setFilters((prev) => ({
      ...prev,
      status: val === NONE ? undefined : (val as AdminLgpdStatus),
    }));
  }

  function setType(val: string) {
    setFilters((prev) => ({
      ...prev,
      request_type: val === NONE ? undefined : (val as AdminLgpdRequestType),
    }));
  }

  function setRisk(val: string) {
    setFilters((prev) => ({
      ...prev,
      risk_level: val === NONE ? undefined : (val as AdminLgpdRiskLevel),
    }));
  }

  function clearFilters() {
    setFilters({});
  }

  const hasActiveFilters = !!(filters.status || filters.request_type || filters.risk_level || filters.tenant_id);

  return (
    <div className="space-y-6">
      {/* Risk banner (uses unfiltered first page) */}
      <LgpdRiskBanner requests={bannerRows} />

      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Proteção de Dados — Cross-tenant</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading
            ? "Carregando..."
            : `${total} solicitaç${total !== 1 ? "ões" : "ão"}${hasNextPage ? "+" : ""}`}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select onValueChange={setStatus} value={filters.status ?? NONE}>
          <SelectTrigger className="h-8 w-[160px] text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Todos os status</SelectItem>
            <SelectItem value="received">Recebido</SelectItem>
            <SelectItem value="processing">Processando</SelectItem>
            <SelectItem value="pending_review">Revisão</SelectItem>
            <SelectItem value="completed">Concluído</SelectItem>
            <SelectItem value="failed">Falhou</SelectItem>
          </SelectContent>
        </Select>

        <Select onValueChange={setType} value={filters.request_type ?? NONE}>
          <SelectTrigger className="h-8 w-[200px] text-xs">
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Todos os tipos</SelectItem>
            <SelectItem value="redact">Anonimização cliente</SelectItem>
            <SelectItem value="data_request">Solicitação de dados</SelectItem>
            <SelectItem value="store_redact">Anonimização tenant</SelectItem>
          </SelectContent>
        </Select>

        <Select onValueChange={setRisk} value={filters.risk_level ?? NONE}>
          <SelectTrigger className="h-8 w-[160px] text-xs">
            <SelectValue placeholder="Risco" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Todos os riscos</SelectItem>
            <SelectItem value="expired">Vencido</SelectItem>
            <SelectItem value="at_risk">Crítico (&lt;24h)</SelectItem>
            <SelectItem value="warning">Alerta (&gt;50%)</SelectItem>
            <SelectItem value="ok">OK</SelectItem>
          </SelectContent>
        </Select>

        {hasActiveFilters && (
          <Badge
            variant="secondary"
            className="cursor-pointer text-xs"
            onClick={clearFilters}
          >
            Limpar filtros ×
          </Badge>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <LgpdRequestsTableSkeleton />
      ) : (
        <LgpdRequestsTable
          data={rows}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
        />
      )}
    </div>
  );
}
