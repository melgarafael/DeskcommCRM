"use client";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentStatus } from "./AgentStatusBadge";

export type StatusFilter = AgentStatus | "all";

interface Props {
  status: StatusFilter;
  onStatusChange: (s: StatusFilter) => void;
  query: string;
  onQueryChange: (q: string) => void;
  showArchived: boolean;
  onShowArchivedChange: (v: boolean) => void;
}

export function AgentsListFilters({
  status,
  onStatusChange,
  query,
  onQueryChange,
  showArchived,
  onShowArchivedChange,
}: Props) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="Buscar por nome…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        className="w-full sm:w-64"
        aria-label="Buscar agents"
      />
      <Select value={status} onValueChange={(v) => onStatusChange(v as StatusFilter)}>
        <SelectTrigger className="w-44" aria-label="Filtrar por status">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todos</SelectItem>
          <SelectItem value="published">Publicado</SelectItem>
          <SelectItem value="paused">Pausado</SelectItem>
          <SelectItem value="archived">Arquivado</SelectItem>
        </SelectContent>
      </Select>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => onShowArchivedChange(e.target.checked)}
          className="size-4"
        />
        Incluir arquivados
      </label>
    </div>
  );
}
