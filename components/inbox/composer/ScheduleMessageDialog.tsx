"use client";

import { useT } from "@/hooks/i18n/useT";
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Info } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  /** Texto atual do composer (pré-preenche a mensagem). */
  body: string;
  onScheduled?: () => void;
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

/** Partes locais a partir de um Date. */
function partesLocais(d: Date) {
  return {
    data: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hora: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Junta data+hora locais em ISO com o fuso do browser (sem ambiguidade UTC). */
function localParaIso(data: string, hora: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  const h = /^(\d{2}):(\d{2})$/.exec(hora);
  if (!m || !h) throw new Error("data_hora_invalida");
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(h[1]),
    Number(h[2]),
    0,
    0,
  );
  if (Number.isNaN(d.getTime())) throw new Error("data_hora_invalida");
  return d.toISOString();
}

function minimoPartes() {
  return partesLocais(new Date(Date.now() + 2 * 60_000));
}

export function ScheduleMessageDialog({
  open,
  onOpenChange,
  conversationId,
  body,
  onScheduled,
}: Props) {
  const t = useT();
  const inicial = minimoPartes();
  const [data, setData] = React.useState(inicial.data);
  const [hora, setHora] = React.useState(inicial.hora);
  const [mensagem, setMensagem] = React.useState(body);
  const [oculto, setOculto] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const m = minimoPartes();
    setData(m.data);
    setHora(m.hora);
    setMensagem(body);
    setOculto(false);
  }, [open, body]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const texto = mensagem.trim();
    if (!texto) {
      toast.error(t("Digite a mensagem antes de agendar."));
      return;
    }
    setPending(true);
    try {
      const sendAt = localParaIso(data, hora);
      await apiClient.post(`/api/v1/conversations/${conversationId}/scheduled-messages`, {
        send_at: sendAt,
        type: "text",
        body: texto,
        atendimento_oculto: oculto,
      });
      toast.success(t("Mensagem agendada."));
      onScheduled?.();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation_failed") {
        const detalhes = err.details as { send_at?: string[] } | undefined;
        const msgCampo = detalhes?.send_at?.[0];
        toast.error(msgCampo ? t(msgCampo) : err.message || t("Dados inválidos."));
      } else {
        showApiError(err);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Novo Agendamento")}</DialogTitle>
          <DialogDescription>
            {t("A mensagem será enviada automaticamente no horário escolhido.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="sched-data">{t("Data")} *</Label>
              <Input
                id="sched-data"
                type="date"
                value={data}
                min={minimoPartes().data}
                onChange={(e) => setData(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sched-hora">{t("Hora")} *</Label>
              <Input
                id="sched-hora"
                type="time"
                value={hora}
                onChange={(e) => setHora(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sched-msg">{t("Mensagem")} *</Label>
            <Textarea
              id="sched-msg"
              value={mensagem}
              onChange={(e) => setMensagem(e.target.value)}
              placeholder={t("Digite sua mensagem…")}
              rows={4}
              required
              maxLength={4096}
            />
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={oculto}
              onChange={(e) => setOculto(e.target.checked)}
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{t("Atendimento oculto")}</span>
              <span
                className={cn("mt-0.5 flex items-start gap-1 text-xs text-muted-foreground")}
                title={t(
                  "Quando ativado, a conversa ficará como pendente até que o contato responda. Isso é útil para evitar que mensagens agendadas apareçam como não lidas antes do contato interagir.",
                )}
              >
                <Info size={14} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                {t("Conversa fica pendente até o contato responder.")}
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={pending || !mensagem.trim()}>
              {t("Agendar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
