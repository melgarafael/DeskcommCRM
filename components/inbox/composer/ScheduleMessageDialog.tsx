"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  /** Texto atual do composer (obrigatório se não houver mídia). */
  body: string;
  onScheduled?: () => void;
}

/** Converte datetime-local (sem fuso) para ISO com offset do browser. */
function localDatetimeParaIso(local: string): string {
  const d = new Date(local);
  return d.toISOString();
}

function minimoLocal(): string {
  const d = new Date(Date.now() + 60_000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleMessageDialog({
  open,
  onOpenChange,
  conversationId,
  body,
  onScheduled,
}: Props) {
  const t = useT();
  const [when, setWhen] = React.useState(minimoLocal());
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (open) setWhen(minimoLocal());
  }, [open]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const texto = body.trim();
    if (!texto) {
      toast.error(t("Digite a mensagem antes de agendar."));
      return;
    }
    setPending(true);
    try {
      await apiClient.post(`/api/v1/conversations/${conversationId}/scheduled-messages`, {
        send_at: localDatetimeParaIso(when),
        type: "text",
        body: texto,
      });
      toast.success(t("Mensagem agendada."));
      onScheduled?.();
      onOpenChange(false);
    } catch (err) {
      showApiError(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Agendar mensagem")}</DialogTitle>
          <DialogDescription>
            {t("A mensagem será enviada automaticamente no horário escolhido.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sched-when">{t("Data e hora")} *</Label>
            <Input
              id="sched-when"
              type="datetime-local"
              value={when}
              min={minimoLocal()}
              onChange={(e) => setWhen(e.target.value)}
              required
            />
          </div>
          {body.trim() ? (
            <p className="line-clamp-3 rounded-md border bg-muted/40 p-2 text-sm text-muted-foreground">
              {body.trim()}
            </p>
          ) : (
            <p className="text-sm text-destructive">
              {t("O campo de mensagem está vazio.")}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={pending || !body.trim()}>
              {t("Agendar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
