"use client";

import { EmptyState } from "@/components/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarBlank } from "@/lib/ui/icons";

export function CarregandoAgendamentos() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-36 w-full rounded-lg" />
      ))}
    </div>
  );
}

export function ListaVaziaAgendamentos({ onNovo }: { onNovo?: () => void }) {
  return (
    <EmptyState
      icon={CalendarBlank}
      headline="Nenhum agendamento neste período"
      subcopy="Ajuste os filtros ou crie um novo agendamento de avaliação."
      primary={
        onNovo ? { label: "Novo agendamento", onClick: onNovo } : undefined
      }
    />
  );
}
