"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

type Agendamento = {
  id: string;
  body: string;
  scheduled_at: string;
  status: "pending" | "sending" | "dispatched" | "failed" | "cancelled";
  error_code: string | null;
};

function horarioInicial(): string {
  const data = new Date(Date.now() + 5 * 60_000);
  data.setSeconds(0, 0);
  // datetime-local espera a hora local, sem sufixo UTC.
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}-${String(data.getDate()).padStart(2, "0")}T${String(data.getHours()).padStart(2, "0")}:${String(data.getMinutes()).padStart(2, "0")}`;
}

const motivoFalha: Record<string, string> = {
  janela_fechada: "A janela de 24 horas fechou antes do envio.",
  conversa_encerrada: "A conversa foi encerrada antes do envio.",
  atendente_removido: "O atendente foi removido antes do envio.",
  atendente_sem_acesso: "O atendente perdeu acesso antes do envio.",
  resultado_incerto: "O resultado do envio é incerto. Confira a conversa antes de reenviar.",
};

export function ScheduledMessages({
  conversationId,
  body,
  disabled,
  quoting,
  onScheduled,
}: {
  conversationId: string;
  body: string;
  disabled: boolean;
  quoting: boolean;
  onScheduled: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [horario, setHorario] = useState(horarioInicial);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const queryKey = ["scheduled-messages", conversationId];

  async function agendar() {
    const dataEscolhida = new Date(horario);
    if (
      !Number.isFinite(dataEscolhida.getTime()) ||
      dataEscolhida.getTime() < Date.now() + 60_000
    ) {
      toast.error(t("Escolha um horário ao menos 1 minuto no futuro."));
      return;
    }
    if (body.trim().length > 4000 || !scheduleId) {
      toast.error(t("A mensagem deve ter até 4.000 caracteres."));
      return;
    }
    setSaving(true);
    try {
      await apiClient.post(`/api/v1/conversations/${conversationId}/scheduled-messages`, {
        id: scheduleId,
        body: body.trim(),
        scheduled_at: dataEscolhida.toISOString(),
      });
      await qc.invalidateQueries({ queryKey });
      setOpen(false);
      onScheduled();
      toast.success(t("Mensagem agendada."));
    } catch (err) {
      showApiError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-9 w-9 shrink-0"
        aria-label={t("Agendar mensagem")}
        title={quoting ? t("Cancele a citação para agendar uma mensagem.") : t("Agendar mensagem")}
        disabled={disabled || quoting || !body.trim()}
        onClick={() => {
          setHorario(horarioInicial());
          setScheduleId(crypto.randomUUID());
          setOpen(true);
        }}
      >
        <CalendarClock className="size-4" aria-hidden />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!saving) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Agendar mensagem")}</DialogTitle>
            <DialogDescription>
              {t(
                "A mensagem será enviada automaticamente no horário escolhido. O agendamento exige que a janela de 24 horas esteja aberta nesse momento; se ela fechar antes, o envio falhará.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm break-words whitespace-pre-wrap">
            {body.trim()}
          </div>
          <label className="space-y-1 text-sm font-medium">
            <span>{t("Data e hora")}</span>
            <input
              type="datetime-local"
              value={horario}
              onChange={(event) => setHorario(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2"
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              {t("Voltar")}
            </Button>
            <Button type="button" disabled={saving || !horario} onClick={() => void agendar()}>
              {saving ? t("Agendando…") : t("Confirmar agendamento")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ScheduledMessagesPanel({ conversationId }: { conversationId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const queryKey = ["scheduled-messages", conversationId];
  const { data, isError } = useQuery({
    queryKey,
    queryFn: async () =>
      (
        await apiClient.get<{ data: Agendamento[] }>(
          `/api/v1/conversations/${conversationId}/scheduled-messages`,
        )
      ).data,
    refetchInterval: 30_000,
  });
  const visiveis = (data ?? []).filter((item) =>
    ["pending", "sending", "failed"].includes(item.status),
  );

  async function cancelar(id: string) {
    setCancelling(id);
    try {
      await apiClient.delete(`/api/v1/conversations/${conversationId}/scheduled-messages/${id}`);
      await qc.invalidateQueries({ queryKey });
      toast.success(t("Agendamento cancelado."));
    } catch (err) {
      showApiError(err);
      await qc.invalidateQueries({ queryKey });
    } finally {
      setCancelling(null);
    }
  }

  if (isError)
    return (
      <div className="mb-2 text-xs text-destructive">
        {t("Não foi possível carregar as mensagens agendadas.")}
      </div>
    );
  if (visiveis.length === 0) return null;
  return (
    <div className="mb-2 max-h-40 space-y-1 overflow-y-auto" aria-label={t("Mensagens agendadas")}>
      {visiveis.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs"
        >
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{item.body}</div>
            <div className="text-muted-foreground">
              {item.status === "pending"
                ? t("Agendada para")
                : item.status === "sending"
                  ? t("Enviando")
                  : t("Falhou")}{" "}
              {new Date(item.scheduled_at).toLocaleString("pt-BR", {
                dateStyle: "short",
                timeStyle: "short",
              })}
              {item.status === "failed" &&
                item.error_code &&
                ` · ${t(motivoFalha[item.error_code] ?? "O envio não foi concluído.")}`}
            </div>
          </div>
          {item.status === "pending" && (
            <button
              type="button"
              className="shrink-0 text-primary hover:underline disabled:opacity-50"
              disabled={cancelling === item.id}
              onClick={() => void cancelar(item.id)}
            >
              {t("Cancelar")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
