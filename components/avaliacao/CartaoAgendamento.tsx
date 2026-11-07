"use client";

import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ROTULO_STATUS } from "@/lib/avaliacao/status";
import { cn } from "@/lib/utils";

import { MenuAcoesAgendamento } from "./MenuAcoesAgendamento";
import type { AgendamentoAvaliacao } from "./tipos";

function embed<T>(v: T | T[] | null | undefined): T | undefined {
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

const COR_STATUS: Record<string, string> = {
  agendado: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  em_avaliacao: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  cancelado: "bg-muted text-muted-foreground",
  atrasado: "bg-red-500/15 text-red-700 dark:text-red-300",
  aguardando: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
  avaliado: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

export function CartaoAgendamento({
  item,
  onEditar,
}: {
  item: AgendamentoAvaliacao;
  onEditar: () => void;
}) {
  const contato = embed(item.contacts);
  const unidade = embed(item.avaliacao_unidades);
  const quando = format(new Date(item.scheduled_at), "EEE, dd/MM · HH:mm", { locale: ptBR });

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <div className="min-w-0 space-y-1">
          <CardTitle className="truncate text-base">{contato?.name ?? "Cliente"}</CardTitle>
          <p className="text-sm text-muted-foreground">{quando}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={cn("shrink-0 border-0", COR_STATUS[item.status])} variant="secondary">
            {ROTULO_STATUS[item.status]}
          </Badge>
          <MenuAcoesAgendamento agendamento={item} onEditar={onEditar} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-1 text-sm">
        <p>{contato?.phone_number ?? "—"}</p>
        <p>
          <span className="text-muted-foreground">Unidade:</span> {unidade?.name ?? "—"}
        </p>
        {[item.vehicle_brand, item.vehicle_model, item.vehicle_plate].filter(Boolean).length > 0 && (
          <p className="text-muted-foreground">
            {[item.vehicle_brand, item.vehicle_model, item.vehicle_plate].filter(Boolean).join(" · ")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
