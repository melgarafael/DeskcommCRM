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
        placeholder="Buscar por nome, slug ou NUIT..."
        value={inputValue}
        onChange={(e) => handleSearch(e.target.value)}
        className="sm:w-80"
        aria-label="Buscar tenants"
      />
      <Select
        value={filters.status ?? "all"}
        onValueChange={handleStatus}
      >
        <SelectTrigger className="sm:w-44" aria-label="Filtrar por status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todos os status</SelectItem>
          <SelectItem value="active">Ativo</SelectItem>
          <SelectItem value="onboarding">Onboarding</SelectItem>
          <SelectItem value="suspended">Suspenso</SelectItem>
          <SelectItem value="redacted">Redigido</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
