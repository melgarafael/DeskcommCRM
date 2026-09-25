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
  /**
   * Onde o compromisso acontece. Decide a PROMESSA da seção: onde o local é o
   * Meet, o que vai ao cliente é o LINK; onde não é, o que vão são os DADOS do
   * compromisso. Prometer link num compromisso presencial é prometer o que não
   * existe. Ausente = Meet, que era o único caso que esta seção atendia.
   */
  location_kind?: string;
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
  const mesmaConversa =
    meeting.delivery_authorization_current === true && meeting.delivery_conversation_id === sendTo;
  // "Já enviado" deixa de TRANCAR e passa a ser o rótulo da ação de reenviar.
  // Quem precisava mandar de novo — o cliente apagou a conversa, trocou de
  // número, a correção de uma remarcação não chegou — não tinha caminho pelo
  // produto e acabava mandando o link à mão, fora do CRM.
  const jaEnviado = mesmaConversa && meeting.delivery_state === "sent";
  // Aguardando continua trancando, e isso não é descuido: ali a entrega já está
  // a caminho, e repetir empilharia pedido.
  const aguardando =
    mesmaConversa && ["waiting_for_link", "queued"].includes(meeting.delivery_state);
  const [confirmando, setConfirmando] = useState(false);
  const ehMeet = (meeting.location_kind ?? "google_meet") === "google_meet";
  const action = useMutation({
    mutationFn: (kind: "retry" | "deliver" | "resend") =>
      apiClient.post(`/api/v1/agenda/agendamentos/${id}/google/meet/${kind}`, {
        revision,
        request_id: meeting.request_id,
        ...(kind === "retry" ? {} : { conversation_id: sendTo }),
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
  const deliveryLabel: Record<string, string> = ehMeet
    ? {
        none: "Link não enviado ainda.",
        waiting_for_link: "Envio autorizado: aguardando o link ficar pronto.",
        queued: "Link aguardando envio nesta conversa.",
        sent: "Link enviado na conversa autorizada.",
        blocked:
          "Entrega impedida. Confira o atendimento e o canal antes de autorizar novamente.",
        stale: "O atendimento mudou. Autorize uma nova entrega na conversa desejada.",
        failed: "O envio falhou. Confira o canal e tente novamente.",
      }
    : {
        // Sem Meet o que sai são os DADOS do compromisso, e nenhuma frase fala
        // de link — inclusive a da fila: não há link para esperar.
        none: "Dados não enviados ainda.",
        waiting_for_link: "Envio autorizado: aguardando a vez na fila.",
        queued: "Dados aguardando envio nesta conversa.",
        sent: "Dados enviados na conversa autorizada.",
        blocked:
          "Entrega impedida. Confira o atendimento e o canal antes de autorizar novamente.",
        stale: "O atendimento mudou. Autorize uma nova entrega na conversa desejada.",
        failed: "O envio falhou. Confira o canal e tente novamente.",
      };
  return (
    <section
      className="mt-3 space-y-3 rounded-md border p-3"
      aria-label={t(ehMeet ? "Google Meet" : "Mandar ao cliente")}
    >
      <h3 className="text-sm font-medium">{t(ehMeet ? "Google Meet" : "Mandar ao cliente")}</h3>
      {/* O estado do LINK só existe onde há link a criar. Num compromisso
          presencial esta linha diria "Link ainda não solicitado" para sempre. */}
      {ehMeet ? (
        <p role="status" className="text-sm">
          {t(stateLabel[meeting.state] ?? "Link ainda não solicitado")}
        </p>
      ) : null}
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
            (ehMeet ? "Link não enviado ainda." : "Dados não enviados ainda."),
        )}
      </p>
      {meeting.can_manage && meeting.state !== "cancelled" && (
        <div className="space-y-2">
          <label htmlFor={`meet-destination-${id}`} className="block text-sm">
            {t(ehMeet ? "Conversa que receberá o link" : "Conversa que receberá os dados")}
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
            // `state === "failed"` é falha de CRIAR LINK: só tranca onde há link.
            disabled={
              !sendTo || action.isPending || (ehMeet && meeting.state === "failed") || aguardando
            }
            onClick={() => (jaEnviado ? setConfirmando(true) : action.mutate("deliver"))}
          >
            {t(
              aguardando
                ? "Envio já autorizado"
                : jaEnviado
                  ? "Enviar de novo"
                  : !ehMeet
                    ? "Mandar ao cliente"
                    : meeting.state === "ready"
                      ? "Enviar link ao cliente"
                      : "Enviar quando ficar pronto",
            )}
          </Button>
          {confirmando ? (
            /* A confirmação é o que substitui, do lado da tela, a proteção que o
               banco dá ao `deliver`: lá o `return false` em estado `sent` impede
               envio em dobro por clique nervoso, e o `resend` passa reto de
               propósito. Sem este passo, o botão destravado seria um caminho
               aberto para mandar duas vezes. */
            <div
              role="dialog"
              aria-label={t("Confirmar reenvio")}
              className="rounded-md border p-3 text-sm"
            >
              <p>
                {t(
                  ehMeet
                    ? "Mandar de novo o link desta reunião para o cliente?"
                    : "Mandar de novo os dados deste compromisso para o cliente?",
                )}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirmando(false);
                    action.mutate("resend");
                  }}
                >
                  {t("Mandar de novo")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmando(false)}>
                  {t("Cancelar")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
