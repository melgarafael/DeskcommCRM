"use client";

import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { UnidadeAvaliacao } from "@/hooks/avaliacao/useUnidadesAvaliacao";
import { ROTULO_STATUS, STATUS_AVALIACAO } from "@/lib/avaliacao/status";
import { CaretLeft, CaretRight } from "@/lib/ui/icons";

import type { FiltrosAvaliacaoState } from "./tipos";

export function FiltrosAvaliacao({
  semanaLabel,
  filtros,
  unidades,
  onAnterior,
  onProxima,
  onHoje,
  onChange,
}: {
  semanaLabel: string;
  filtros: FiltrosAvaliacaoState;
  unidades: UnidadeAvaliacao[];
  onAnterior: () => void;
  onProxima: () => void;
  onHoje: () => void;
  onChange: (patch: Partial<FiltrosAvaliacaoState>) => void;
}) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const deLocal = format(new Date(filtros.de), "dd/MM/yyyy", { locale: localeDaData });
  const ateLocal = format(new Date(filtros.ate), "dd/MM/yyyy", { locale: localeDaData });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="icon" onClick={onAnterior} aria-label="Semana anterior">
          <CaretLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onProxima}
          aria-label={t("Próxima semana")}
        >
          <CaretRight className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onHoje}>
          Hoje
        </Button>
        <span className="text-sm font-medium">{semanaLabel}</span>
        <span className="text-xs text-muted-foreground">
          {deLocal} — {ateLocal}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
        <div className="space-y-1">
          <Label>Status</Label>
          <Select
            value={filtros.status ?? "todos"}
            onValueChange={(v) =>
              onChange({ status: v === "todos" ? "todos" : (v as (typeof STATUS_AVALIACAO)[number]) })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder={t("Todos")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">{t("Todos")}</SelectItem>
              {STATUS_AVALIACAO.map((s) => (
                <SelectItem key={s} value={s}>
                  {ROTULO_STATUS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label>Unidade</Label>
          <Select
            value={filtros.unit_id ?? "todas"}
            onValueChange={(v) => onChange({ unit_id: v === "todas" ? undefined : v })}
          >
            <SelectTrigger>
              <SelectValue placeholder={t("Todas")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">{t("Todas")}</SelectItem>
              {unidades
                .filter((u) => u.is_active)
                .map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1 sm:col-span-2 lg:col-span-2">
          <Label>Busca</Label>
          <Input
            placeholder="Nome, placa ou modelo"
            value={filtros.q ?? ""}
            onChange={(e) => onChange({ q: e.target.value || undefined })}
          />
        </div>
      </div>
    </div>
  );
}
