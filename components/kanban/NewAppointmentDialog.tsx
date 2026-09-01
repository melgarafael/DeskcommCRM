"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface AppointmentType {
  id: string;
  name: string;
  duration_minutes: number;
}

interface Slot {
  startsAt: string;
  endsAt: string;
}

interface Props {
  leadId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function NewAppointmentDialog({ leadId, open, onOpenChange, onCreated }: Props) {
  const [types, setTypes] = useState<AppointmentType[]>([]);
  const [typeId, setTypeId] = useState("");
  const [date, setDate] = useState(() => toDateInputValue(new Date()));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotEscolhido, setSlotEscolhido] = useState<Slot | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [erroTipos, setErroTipos] = useState(false);
  const [erroSlots, setErroSlots] = useState(false);
  const [carregandoSlots, setCarregandoSlots] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelado = false;
    setErroTipos(false);
    fetch("/api/v1/appointment-types")
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json();
      })
      .then((json: { data?: AppointmentType[] }) => {
        if (!cancelado) setTypes(json.data ?? []);
      })
      .catch(() => {
        if (!cancelado) setErroTipos(true);
      });
    return () => {
      cancelado = true;
    };
  }, [open]);

  useEffect(() => {
    if (!typeId || !date) {
      setSlots([]);
      return;
    }
    let cancelado = false;
    setCarregandoSlots(true);
    setErroSlots(false);
    fetch(`/api/v1/appointments/available-slots?type_id=${typeId}&date=${date}`)
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json();
      })
      .then((json: { data?: Slot[] }) => {
        if (!cancelado) setSlots(json.data ?? []);
      })
      .catch(() => {
        if (!cancelado) {
          setSlots([]);
          setErroSlots(true);
        }
      })
      .finally(() => {
        if (!cancelado) setCarregandoSlots(false);
      });
    return () => {
      cancelado = true;
    };
  }, [typeId, date]);

  async function confirmar() {
    if (!typeId || !slotEscolhido) {
      toast.error("Escolha um tipo e um horário.");
      return;
    }
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/appointments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lead_id: leadId,
          appointment_type_id: typeId,
          scheduled_at: slotEscolhido.startsAt,
        }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        toast.error(json.error?.message ?? "Erro ao marcar horário.");
        return;
      }
      toast.success("Horário marcado.");
      onOpenChange(false);
      onCreated();
    } catch {
      toast.error("Erro ao marcar horário.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar horário</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label>Tipo de agendamento</Label>
            <Select value={typeId} onValueChange={setTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Escolha o tipo" />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.duration_minutes} min)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {erroTipos && (
              <p className="text-xs text-destructive">Erro ao carregar tipos de agendamento.</p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <Label>Data</Label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Horário</Label>
            {carregandoSlots && <p className="text-xs text-muted-foreground">Carregando horários…</p>}
            {!carregandoSlots && erroSlots && (
              <p className="text-xs text-destructive">Erro ao carregar horários livres.</p>
            )}
            {!carregandoSlots && !erroSlots && slots.length === 0 && (
              <p className="text-xs text-muted-foreground">Nenhum horário livre neste dia.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {slots.map((s) => (
                <Button
                  key={s.startsAt}
                  type="button"
                  size="sm"
                  variant={slotEscolhido?.startsAt === s.startsAt ? "default" : "outline"}
                  onClick={() => setSlotEscolhido(s)}
                >
                  {new Date(s.startsAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </Button>
              ))}
            </div>
          </div>
          <Button type="button" onClick={confirmar} disabled={salvando}>
            {salvando ? "Marcando…" : "Confirmar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
