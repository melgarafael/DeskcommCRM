"use client";
import { useCallback, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdminTenantsFilters } from "@/hooks/useAdminTenants";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TenantsFiltersProps {
  filters: AdminTenantsFilters;
  onChange: (filters: AdminTenantsFilters) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TenantsFilters({ filters, onChange }: TenantsFiltersProps) {
  const t = useT();
  const [inputValue, setInputValue] = useState(filters.q ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = useCallback(
    (value: string) => {
      setInputValue(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onChange({ ...filters, q: value || undefined });
      }, 300);
    },
    [filters, onChange],
  );

  const handleStatus = useCallback(
    (value: string) => {
      onChange({
        ...filters,
        status: value === "all" ? undefined : (value as AdminTenantsFilters["status"]),
      });
    },
    [filters, onChange],
  );

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Input
        placeholder={t("Buscar por nome, slug ou NIF...")}
        value={inputValue}
        onChange={(e) => handleSearch(e.target.value)}
        className="sm:w-80"
        aria-label={t("Buscar tenants")}
      />
      <Select
        value={filters.status ?? "all"}
        onValueChange={handleStatus}
      >
        <SelectTrigger className="sm:w-44" aria-label={t("Filtrar por status")}>
          <SelectValue placeholder={t("Status")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("Todos os status")}</SelectItem>
          <SelectItem value="active">{t("Ativo")}</SelectItem>
          <SelectItem value="onboarding">{t("Onboarding")}</SelectItem>
          <SelectItem value="suspended">{t("Suspenso")}</SelectItem>
          <SelectItem value="redacted">{t("Redigido")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
