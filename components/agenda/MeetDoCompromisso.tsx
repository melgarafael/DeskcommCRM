"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { meetingErrors, meetingDeliveryErrors } from "@/lib/agenda/google/meet";
import { copyToClipboard } from "@/lib/clipboard";

export interface MeetingDetail {
  state: string;
  url: string | null;
  request_id: string | null;
  error: keyof typeof meetingErrors | null;
  delivery_state: string;
  delivery_authorization_current?: boolean;
  delivery_error?: string | null;
  delivery_conversation_id?: string | null;
  can_manage: boolean;
  destinations: Array<{ id: string; label: string }>;
}
export function MeetDoCompromisso({
  id,
  revision,
  meeting,
  onSaved,
}: {
  id: string;
  revision: string;
  meeting: MeetingDetail;
  onSaved: () => void;
}) {
  const t = useT();
  const [destination, setDestination] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const sendTo = destination || meeting.destinations[0]?.id || "";
  const alreadyAuthorized =
    meeting.delivery_authorization_current === true &&
    meeting.delivery_conversation_id === sendTo &&
    ["waiting_for_link", "queued", "sent"].includes(meeting.delivery_state);
  const action = useMutation({
    mutationFn: (kind: "retry" | "deliver") =>
      apiClient.post(`/api/v1/agenda/agendamentos/${id}/google/meet/${kind}`, {
        revision,
        request_id: meeting.request_id,
        ...(kind === "deliver" ? { conversation_id: sendTo } : {}),
      }),
    onSuccess: onSaved,
    onError: (e) => {
      showApiError(e);
      onSaved();
    },
  });
  const stateLabel: Record<string, string> = {
    not_requested: "Link ainda não solicitado",
    pending: "Criando link do Google Meet",
    ready: "Link do Google Meet pronto",
    failed: "Não foi possível confirmar o link",
    cancelled: "Solicitação de link cancelada",
  };
  const deliveryLabel: Record<string, string> = {
    none: "O envio do link ainda não foi autorizado.",
    waiting_for_link: "Envio autorizado: aguardando o link ficar pronto.",
    queued: "Link aguardando envio nesta conversa.",
    sent: "Link enviado na conversa autorizada.",
    blocked: "Entrega impedida. Confira o atendimento e o canal antes de autorizar novamente.",
    stale: "O atendimento mudou. Autorize uma nova entrega na conversa desejada.",
    failed: "O envio falhou. Confira o canal e tente novamente.",
  };
  return (
    <section className="mt-3 space-y-3 rounded-md border p-3" aria-label={t("Google Meet")}>
      <h3 className="text-sm font-medium">Google Meet</h3>
      <p role="status" className="text-sm">
        {t(stateLabel[meeting.state] ?? "Link ainda não solicitado")}
      </p>
      {meeting.state === "ready" && meeting.url && (
        <div className="flex flex-wrap gap-2">
          <a
            className="text-sm underline"
            href={meeting.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("Abrir reunião")}
          </a>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const success = await copyToClipboard(meeting.url!);
              setCopied(success);
              setCopyFailed(!success);
            }}
          >
            {t(copied ? "Link copiado" : "Copiar link")}
          </Button>
          {copyFailed && (
            <p role="alert" className="w-full text-sm">
              {t("Não foi possível copiar. Use o link de abrir reunião para acessar a sala.")}
            </p>
          )}
        </div>
      )}
      {meeting.error && (
        <p role="alert" className="text-sm">
          {t(meetingErrors[meeting.error])}
        </p>
      )}
      {meeting.can_manage && meeting.state === "failed" && (
        <Button
          variant="outline"
          size="sm"
          disabled={action.isPending}
          onClick={() => action.mutate("retry")}
        >
          {t(
            meeting.error === "google_failure"
              ? "Tentar criar link novamente"
              : "Verificar link novamente",
          )}
        </Button>
      )}
      <p className="text-sm">
        {t(
          (meeting.delivery_error ? meetingDeliveryErrors[meeting.delivery_error] : null) ??
            deliveryLabel[meeting.delivery_state] ??
            "O envio do link ainda não foi autorizado.",
        )}
      </p>
      {meeting.can_manage && meeting.state !== "cancelled" && (
        <div className="space-y-2">
          <label htmlFor={`meet-destination-${id}`} className="block text-sm">
            {t("Conversa que receberá o link")}
          </label>
          <select
            id={`meet-destination-${id}`}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={sendTo}
            onChange={(e) => setDestination(e.target.value)}
            disabled={!meeting.destinations.length || action.isPending}
          >
            {!meeting.destinations.length && (
              <option value="">{t("Nenhum atendimento aberto para este contato")}</option>
            )}
            {meeting.destinations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={
              !sendTo || action.isPending || meeting.state === "failed" || alreadyAuthorized
            }
            onClick={() => action.mutate("deliver")}
          >
            {t(
              alreadyAuthorized
                ? meeting.delivery_state === "sent"
                  ? "Link já enviado"
                  : "Envio já autorizado"
                : meeting.state === "ready"
                  ? "Enviar link ao cliente"
                  : "Enviar quando ficar pronto",
            )}
          </Button>
        </div>
      )}
    </section>
  );
}
