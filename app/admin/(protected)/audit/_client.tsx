"use client";
import { useState } from "react";
import { useAdminAuditLog, type AdminAuditFilters } from "@/hooks/useAdminAuditLog";
import { useAdminTenants } from "@/hooks/useAdminTenants";
import { AuditFiltersAdmin } from "@/components/admin/audit/AuditFiltersAdmin";
import {
  AuditTable,
  AuditTableSkeleton,
} from "@/components/admin/audit/AuditTable";
import { useT } from "@/hooks/i18n/useT";

export function AuditClient() {
  const t = useT();
  const [filters, setFilters] = useState<AdminAuditFilters>({});

  // Load tenants for the multi-select (up to 200)
  const { data: tenantsData } = useAdminTenants({});
  const tenants = (tenantsData?.pages ?? []).flatMap((p) => p.data ?? []).map((t) => ({
    id: t.id,
    slug: t.slug,
    display_name: t.display_name,
  }));

  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useAdminAuditLog(filters);

  const rows = data?.pages.flatMap((p) => p.data ?? []) ?? [];
  const total = rows.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-medium text-text tracking-tight">{t("Audit Log")}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading
            ? t("Carregando...")
            : `${total} ${total !== 1 ? t("eventos") : t("evento")}${hasNextPage ? "+" : ""}`}
        </p>
      </div>

      {/* Filters */}
      <AuditFiltersAdmin filters={filters} onChange={setFilters} tenants={tenants} />

      {/* Table */}
      {isLoading ? (
        <AuditTableSkeleton />
      ) : (
        <AuditTable
          data={rows}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => void fetchNextPage()}
        />
      )}
    </div>
  );
}
