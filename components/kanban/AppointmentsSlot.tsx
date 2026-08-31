"use client";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { NewAppointmentDialog } from "./NewAppointmentDialog";

interface AppointmentRow {
  id: string;
  scheduled_at: string;
  status: "scheduled" | "completed" | "cancelled" | "no_show";
}

interface Props {
  leadId: string;
}

/**
 * Slot do cabeçalho do dossiê — mesmo padrão de `ScoreSlot`/`CobrarButton`:
 * um pedaço isolado, com a própria busca de dado, que o `LeadDossier` só
 * posiciona.
 */
export function AppointmentsSlot({ leadId }: Props) {
  const [proximo, setProximo] = useState<AppointmentRow | null>(null);
  const [erro, setErro] = useState(false);
  const [dialogAberto, setDialogAberto] = useState(false);

  async function carregar() {
    try {
      const res = await fetch(`/api/v1/appointments?lead_id=${leadId}&from=${new Date().toISOString()}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as { data?: AppointmentRow[] };
      const futuros = (json.data ?? []).filter((a) => a.status === "scheduled");
      setProximo(futuros[0] ?? null);
      setErro(false);
    } catch {
      setErro(true);
    }
  }

  useEffect(() => {
    void carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  return (
    <>
      <div className="flex items-center gap-2 text-xs">
        {erro ? (
          <span className="text-destructive">Erro ao carregar agendamentos.</span>
        ) : proximo ? (
          <span className="text-text-muted">
            Próximo horário: {new Date(proximo.scheduled_at).toLocaleString("pt-BR")}
          </span>
        ) : (
          <span className="text-text-muted">Sem horário marcado</span>
        )}
        <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setDialogAberto(true)}>
          Marcar horário
        </Button>
      </div>
      <NewAppointmentDialog
        leadId={leadId}
        open={dialogAberto}
        onOpenChange={setDialogAberto}
        onCreated={() => void carregar()}
      />
    </>
  );
}
