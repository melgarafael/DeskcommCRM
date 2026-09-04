"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CaretDown, X } from "@/lib/ui/icons";
import type { AdminAuditFilters } from "@/hooks/useAdminAuditLog";
// A lista vem do vocabulário canônico, não de uma cópia local. Havia uma
// (`./action-codes.ts`), mantida à mão, e ela tinha ficado 120 códigos atrás do
// que o produto emite — filtro que não oferece a opção lê-se como "isso não
// acontece". `lib/audit/actions.ts` não importa nada, de propósito: é o que
// mantém este import de cliente barato. Ver o cabeçalho de lá.
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TenantOption {
  id: string;
  slug: string;
  display_name: string;
}

interface AuditFiltersAdminProps {
  filters: AdminAuditFilters;
  onChange: (filters: AdminAuditFilters) => void;
  tenants: TenantOption[];
}

// ---------------------------------------------------------------------------
// Multi-select helpers
// ---------------------------------------------------------------------------

function MultiSelectPopover({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 text-sm font-normal"
          aria-label={label}
        >
          {label}
          {selected.length > 0 && (
            <Badge variant="info" className="h-4 px-1 text-[10px]">
              {selected.length}
            </Badge>
          )}
          <CaretDown size={14} aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="space-y-1">
          <Input
            placeholder={t("Buscar...")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
          />
          {selected.length > 0 && (
            <button
              onClick={() => { onClear(); setSearch(""); }}
              className="w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
            >
              {t("Limpar seleção")} ({selected.length})
            </button>
          )}
          <div className="max-h-52 overflow-y-auto space-y-0.5">
            {filtered.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                {t("Nenhum resultado")}
              </p>
            )}
            {filtered.map((o) => (
              <button
                key={o.value}
                onClick={() => onToggle(o.value)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  selected.includes(o.value)
                    ? "bg-accent font-medium"
                    : "hover:bg-accent/50"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditFiltersAdmin({
  filters,
  onChange,
  tenants,
}: AuditFiltersAdminProps) {
  const t = useT();
  const [actorInput, setActorInput] = useState(filters.actor_user_id ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tenantOptions = tenants.map((t) => ({
    value: t.id,
    label: `${t.display_name} (${t.slug})`,
  }));

  // Rótulo = o próprio código, e é decisão, não preguiça: a busca do popover
  // filtra por `label`, então digitar `lgpd.` recorta a família inteira — que é
  // como um auditor procura. Inventar 209 rótulos em PT-BR recriaria, com outra
  // roupa, a segunda lista à mão que este componente acabou de matar.
  // `useMemo` porque a lista é constante e tem 209 itens: sem ele, cada tecla
  // digitada no campo "Actor" remonta o array inteiro.
  const actionOptions = useMemo(
    () => AUDIT_ACTIONS.map((a) => ({ value: a, label: a })),
    [],
  );

  const selectedTenants = useMemo(() => filters.tenant_ids ?? [], [filters.tenant_ids]);
  const selectedActions = useMemo(() => filters.actions ?? [], [filters.actions]);

  const toggleTenant = useCallback(
    (id: string) => {
      const next = selectedTenants.includes(id)
        ? selectedTenants.filter((t) => t !== id)
        : [...selectedTenants, id];
      onChange({ ...filters, tenant_ids: next.length > 0 ? next : undefined });
    },
    [filters, onChange, selectedTenants],
  );

  const toggleAction = useCallback(
    (action: string) => {
      const next = selectedActions.includes(action)
        ? selectedActions.filter((a) => a !== action)
        : [...selectedActions, action];
      onChange({ ...filters, actions: next.length > 0 ? next : undefined });
    },
    [filters, onChange, selectedActions],
  );

  const handleActorChange = useCallback(
    (value: string) => {
      setActorInput(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onChange({ ...filters, actor_user_id: value.trim() || undefined });
      }, 400);
    },
    [filters, onChange],
  );

  const handleFromChange = useCallback(
    (value: string) => {
      onChange({ ...filters, from: value ? new Date(value).toISOString() : undefined });
    },
    [filters, onChange],
  );

  const handleToChange = useCallback(
    (value: string) => {
      onChange({ ...filters, to: value ? new Date(value).toISOString() : undefined });
    },
    [filters, onChange],
  );

  const hasAnyFilter =
    selectedTenants.length > 0 ||
    selectedActions.length > 0 ||
    !!filters.actor_user_id ||
    !!filters.from ||
    !!filters.to;

  const clearAll = () => {
    setActorInput("");
    onChange({});
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <MultiSelectPopover
        label="Tenants"
        options={tenantOptions}
        selected={selectedTenants}
        onToggle={toggleTenant}
        onClear={() => onChange({ ...filters, tenant_ids: undefined })}
      />
      <MultiSelectPopover
        label="Actions"
        options={actionOptions}
        selected={selectedActions}
        onToggle={toggleAction}
        onClear={() => onChange({ ...filters, actions: undefined })}
      />
      <Input
        placeholder="Actor (user ID)"
        value={actorInput}
        onChange={(e) => handleActorChange(e.target.value)}
        className="h-9 w-60 text-sm"
        aria-label={t("Filtrar por actor user ID")}
      />
      <div className="flex items-center gap-1">
        <label className="text-xs text-muted-foreground sr-only" htmlFor="audit-from">
          {t("De")}
        </label>
        <Input
          id="audit-from"
          type="datetime-local"
          className="h-9 w-48 text-sm"
          onChange={(e) => handleFromChange(e.target.value)}
          aria-label={t("Data de início")}
        />
      </div>
      <div className="flex items-center gap-1">
        <label className="text-xs text-muted-foreground sr-only" htmlFor="audit-to">
          {t("Até")}
        </label>
        <Input
          id="audit-to"
          type="datetime-local"
          className="h-9 w-48 text-sm"
          onChange={(e) => handleToChange(e.target.value)}
          aria-label={t("Data de fim")}
        />
      </div>
      {hasAnyFilter && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 gap-1 text-muted-foreground"
          onClick={clearAll}
        >
          <X size={14} aria-hidden />
          {t("Limpar")}
        </Button>
      )}
    </div>
  );
}
