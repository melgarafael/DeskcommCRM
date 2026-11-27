"use client";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import type { FiltroDeStatusDoFluxo } from "@/lib/followup/filtrar-fluxos";

interface Props {
  status: FiltroDeStatusDoFluxo;
  onStatusChange: (s: FiltroDeStatusDoFluxo) => void;
  query: string;
  onQueryChange: (q: string) => void;
  /** A busca também casa com o gatilho (Follow-ups; não nos fluxos de atendimento, #4593). */
  buscaPeloGatilho?: boolean;
}

/** Busca e filtro por status da lista de fluxos — o mesmo jeito da lista de Agentes (#4593). */
export function FlowsListFilters({ status, onStatusChange, query, onQueryChange, buscaPeloGatilho = false }: Props) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder={buscaPeloGatilho ? t("Buscar por nome ou gatilho…") : t("Buscar por nome…")}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        className="w-full sm:w-64"
        aria-label={t("Buscar fluxos")}
      />
      <Select value={status} onValueChange={(v) => onStatusChange(v as FiltroDeStatusDoFluxo)}>
        <SelectTrigger className="w-44" aria-label={t("Filtrar por status")}>
          <SelectValue placeholder={t("Status")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("Todos")}</SelectItem>
          <SelectItem value="active">{t("Ativo")}</SelectItem>
          <SelectItem value="draft">{t("Rascunho")}</SelectItem>
          <SelectItem value="disabled">{t("Desativado")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
