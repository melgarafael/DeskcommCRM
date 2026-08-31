"use client";
import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface AppointmentRow {
  id: string;
  lead_id: string;
  scheduled_at: string;
  duration_minutes: number;
  status: "scheduled" | "completed" | "cancelled" | "no_show";
}

const STATUS_LABEL: Record<AppointmentRow["status"], string> = {
  scheduled: "Marcado",
  completed: "Concluído",
  cancelled: "Cancelado",
  no_show: "Não compareceu",
};

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function AgendaClient() {
  const [date, setDate] = useState(() => toDateInputValue(new Date()));
  const [items, setItems] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    let cancelado = false;
    setLoading(true);
    const from = `${date}T00:00:00.000Z`;
    // Início do dia SEGUINTE como limite exclusivo — evita o off-by-one de
    // `23:59:59.999Z` (um agendamento no milissegundo exato ficaria de fora).
    const proximoDia = new Date(`${date}T00:00:00.000Z`);
    proximoDia.setUTCDate(proximoDia.getUTCDate() + 1);
    const to = proximoDia.toISOString();
    fetch(`/api/v1/appointments?from=${from}&to=${to}`)
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json();
      })
      .then((json: { data?: AppointmentRow[] }) => {
        if (!cancelado) {
          setItems(json.data ?? []);
          setErro(false);
        }
      })
      .catch(() => {
        if (!cancelado) setErro(true);
      })
      .finally(() => {
        if (!cancelado) setLoading(false);
      });
    return () => {
      cancelado = true;
    };
  }, [date]);

  function mudarDia(delta: number) {
    const atual = new Date(`${date}T12:00:00Z`);
    atual.setUTCDate(atual.getUTCDate() + delta);
    setDate(toDateInputValue(atual));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => mudarDia(-1)}>
          ← Dia anterior
        </Button>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        />
        <Button variant="outline" size="sm" onClick={() => mudarDia(1)}>
          Próximo dia →
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {!loading && erro && (
        <p className="text-sm text-destructive">Erro ao carregar agenda. Tente novamente.</p>
      )}
      {!loading && !erro && items.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhum agendamento neste dia.</p>
      )}
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <Card key={item.id}>
            <CardContent className="flex items-center justify-between gap-4 py-3">
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {new Date(item.scheduled_at).toLocaleTimeString("pt-BR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  · {item.duration_minutes} min
                </span>
                <a href={`/app/kanban?lead=${item.lead_id}`} className="text-xs text-muted-foreground underline">
                  Ver lead
                </a>
              </div>
              <Badge variant={item.status === "cancelled" ? "outline" : "default"}>
                {STATUS_LABEL[item.status]}
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
