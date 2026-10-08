"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useCaseTask, useActOnCaseTask } from "@/hooks/ai/useCaseTask";
import { useT } from "@/hooks/i18n/useT";
import type { CaseTaskAction, CaseTaskFields } from "@/lib/ai/case-task";

const STATE_LABEL: Record<NonNullable<CaseTaskFields["task_state"]>, string> = {
  awaiting_human: "Aguardando a equipe",
  awaiting_send: "Envio pendente",
  send_failed: "Falha no envio — precisa de ação",
  awaiting_lead: "Aguardando informação da cliente",
  completed: "Envio confirmado pelo canal",
};

type Decision = "payment_confirmed" | "payment_not_found" | "need_information";

export function PaymentTaskPanel({ caseId }: { caseId: string }) {
  const task = useCaseTask(caseId);
  const mutation = useActOnCaseTask(caseId);
  return (
    <PaymentTaskForm
      key={`${caseId}:${task.data?.wait_generation}:${task.data?.task_kind}`}
      caseId={caseId}
      task={task}
      mutation={mutation}
    />
  );
}

function PaymentTaskForm({
  caseId,
  task,
  mutation,
}: {
  caseId: string;
  task: ReturnType<typeof useCaseTask>;
  mutation: ReturnType<typeof useActOnCaseTask>;
}) {
  const t = useT();
  const [selectedMethod, setMethod] = useState<"pix" | "card" | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [purchase, setPurchase] = useState("");
  const [postDelivery, setPostDelivery] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const data = task.data;
  const method = selectedMethod ?? (data?.task_payload.payment_method === "card" ? "card" : "pix");
  const waiting = data?.task_state === "awaiting_human" || data?.task_state === "send_failed";
  const started = waiting ? data?.wait_started_at : null;

  useEffect(() => {
    const update = () =>
      setElapsed(
        started ? Math.max(0, Math.floor((Date.now() - Date.parse(started)) / 60_000)) : 0,
      );
    update();
    const timer = setInterval(update, 15_000);
    return () => clearInterval(timer);
  }, [started]);

  function act(input: Omit<CaseTaskAction, "expected_revision">) {
    if (!data) return;
    mutation.mutate(
      { ...input, expected_revision: data.revision },
      {
        onSuccess: () => {
          toast.success(t("Ação registrada. Confira o estado do envio neste caso."));
          setDecision(null);
          setText("");
          setNote("");
        },
        onError: showApiError,
      },
    );
  }

  function choose(value: Decision) {
    setDecision(value);
    setText(
      value === "payment_confirmed"
        ? t("O recebimento do pagamento do seu pedido foi confirmado.")
        : "",
    );
    setNote("");
  }

  if (task.isLoading) return <p role="status">{t("Carregando a tarefa de pagamento…")}</p>;
  if (task.error || !data)
    return (
      <div role="alert" className="rounded-lg border border-border p-4">
        <p>{t("Não foi possível carregar a tarefa. Atualize antes de confirmar qualquer dado.")}</p>
        <Button variant="outline" onClick={() => void task.refetch()}>
          {t("Tentar novamente")}
        </Button>
      </div>
    );
  if (!data.task_kind || !data.task_state) return null;

  const mine = data.assigned_to_me === true;
  const details = data.task_kind === "payment_details";
  const editable = mine && waiting && !mutation.isPending && data.lead_id !== null;
  const needsNote = decision === "payment_not_found" || decision === "need_information";
  const canSubmit =
    editable &&
    text.trim().length > 0 &&
    (details || (decision !== null && (!needsNote || note.trim().length > 0)));

  return (
    <section
      aria-label={t("Tarefa de pagamento")}
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t(details ? "Enviar dados oficiais" : "Conferir recebimento")}
        </h3>
        <Badge
          variant={
            data.task_state === "send_failed" || (waiting && elapsed >= 9) ? "warning" : "neutral"
          }
        >
          {t(STATE_LABEL[data.task_state])}
        </Badge>
      </div>
      <p className="text-sm">
        {t("Compra")}:{" "}
        {data.lead_title ??
          t(data.lead_id ? "Compra vinculada ao caso" : "Compra ainda não identificada")}
      </p>
      <p className="text-sm">
        {t("Responsável")}:{" "}
        {data.assignee_name ??
          t(data.assignee_user_id ? "Outro integrante da equipe" : "Ainda não assumido")}
      </p>
      {waiting ? (
        <p className="text-xs text-muted-foreground">
          {t("Espera da equipe")}: {elapsed} {t("minutos")}.{" "}
          {t(
            "A Central avisa aos 3, 6 e 9 minutos. O WhatsApp da equipe repete esses marcos se a opção estiver ativa em Avisos. Assumir ou comentar não reinicia o prazo.",
          )}
        </p>
      ) : null}
      {waiting && elapsed >= 9 ? (
        <p role="status" className="text-sm font-medium">
          {t("Atrasado — continua pendente até a tarefa ser resolvida.")}
        </p>
      ) : null}
      {!data.lead_id ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm">
            {t("Identifique a compra antes de liberar dados ou confirmar pagamento.")}
          </p>
          <Label htmlFor={`payment-purchase-${caseId}`}>{t("Compra deste atendimento")}</Label>
          <select
            id={`payment-purchase-${caseId}`}
            value={purchase}
            disabled={!mine || mutation.isPending}
            onChange={(e) => setPurchase(e.target.value)}
            className="w-full rounded-md border border-border bg-surface p-2 text-sm"
          >
            <option value="">{t("Selecione a compra")}</option>
            {data.purchase_candidates?.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={!mine || !purchase || mutation.isPending}
            onClick={() => act({ action: "link_purchase", lead_id: purchase })}
          >
            {t("Vincular compra ao caso")}
          </Button>
          {!data.purchase_candidates?.length ? (
            <p className="text-xs text-muted-foreground">
              {t(
                "Nenhuma compra disponível. Cadastre o negócio no CRM para este contato e atualize o caso.",
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!data.assignee_user_id && waiting ? (
          <Button disabled={mutation.isPending} onClick={() => act({ action: "assume" })}>
            {t("Assumir caso")}
          </Button>
        ) : null}
        {data.assignee_user_id && !mine && data.can_reassign && waiting ? (
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => act({ action: "takeover" })}
          >
            {t("Reassumir tarefa como gestor")}
          </Button>
        ) : null}
        {mine && waiting ? (
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => act({ action: "release" })}
          >
            {t("Devolver à equipe")}
          </Button>
        ) : null}
      </div>
      {!mine && waiting ? (
        <p className="text-xs text-muted-foreground">
          {t(
            data.assignee_user_id
              ? "O responsável deve registrar a decisão ou devolver a tarefa à equipe."
              : "Assuma esta tarefa para registrar sua decisão. A Bia continua atendendo a cliente.",
          )}
        </p>
      ) : null}
      {data.task_state === "awaiting_send" ? (
        <p role="status" className="text-sm">
          {t(
            "A decisão foi registrada; a mensagem ainda está sendo processada. Esta tela só confirma o envio após o resultado do canal.",
          )}
        </p>
      ) : null}
      {data.task_state === "completed" ? (
        <p role="status" className="text-sm">
          {t(
            details
              ? "O canal confirmou o envio dos dados oficiais. Isso não confirma a leitura pela cliente nem o pagamento."
              : "A equipe registrou a confirmação do pagamento e o canal confirmou o envio da mensagem. Isso não confirma a leitura pela cliente.",
          )}
        </p>
      ) : null}
      {data.task_state === "send_failed" ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm">
            {t(
              "A mensagem não teve envio confirmado. Revise a conexão e tente novamente; a decisão financeira registrada permanece válida.",
            )}
          </p>
          <Button disabled={!editable} onClick={() => act({ action: "retry_send" })}>
            {t("Tentar envio novamente")}
          </Button>
        </div>
      ) : null}
      {data.task_state === "awaiting_human" ? (
        <>
          {details ? (
            <div className="space-y-2">
              <Label htmlFor={`payment-method-${caseId}`}>{t("Forma de pagamento")}</Label>
              <select
                id={`payment-method-${caseId}`}
                value={method}
                disabled={!editable}
                onChange={(e) => setMethod(e.target.value === "card" ? "card" : "pix")}
                className="w-full rounded-md border border-border bg-surface p-2 text-sm"
              >
                <option value="pix">Pix</option>
                <option value="card">{t("Cartão")}</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Revise os dados oficiais que serão enviados. Liberar os dados não confirma recebimento do pagamento.",
                )}
              </p>
              <Label htmlFor={`payment-followup-${caseId}`}>
                {t("Acompanhamento após enviar os dados")}
              </Label>
              <select
                id={`payment-followup-${caseId}`}
                value={postDelivery}
                disabled={!editable}
                onChange={(e) => setPostDelivery(e.target.value)}
                className="w-full rounded-md border border-border bg-surface p-2 text-sm"
              >
                <option value="">{t("Sem acompanhamento automático")}</option>
                {data.post_delivery_options?.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t("O fluxo escolhido começa somente após o canal confirmar o envio dos dados.")}
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant={decision === "payment_confirmed" ? "default" : "outline"}
                aria-pressed={decision === "payment_confirmed"}
                disabled={!editable}
                onClick={() => choose("payment_confirmed")}
              >
                {t("Pagamento confirmado")}
              </Button>
              <Button
                variant={decision === "payment_not_found" ? "default" : "outline"}
                aria-pressed={decision === "payment_not_found"}
                disabled={!editable}
                onClick={() => choose("payment_not_found")}
              >
                {t("Não localizado")}
              </Button>
              <Button
                variant={decision === "need_information" ? "default" : "outline"}
                aria-pressed={decision === "need_information"}
                disabled={!editable}
                onClick={() => choose("need_information")}
              >
                {t("Pedir informação")}
              </Button>
            </div>
          )}
          <Label htmlFor={`payment-text-${caseId}`}>
            {t("Texto revisado para enviar à cliente")}
          </Label>
          <Textarea
            id={`payment-text-${caseId}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!editable}
            maxLength={4000}
            rows={4}
            placeholder={t(
              details
                ? "Cole os dados oficiais de Pix ou o link oficial do cartão."
                : "Escreva a comunicação da decisão ou a pergunta necessária.",
            )}
          />
          {needsNote ? (
            <>
              <Label htmlFor={`payment-note-${caseId}`}>{t("Próximo passo da conferência")}</Label>
              <Textarea
                id={`payment-note-${caseId}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={!editable}
                maxLength={4000}
                placeholder={t("Informe o que falta ou o que deve acontecer em seguida.")}
              />
            </>
          ) : null}
          <Button
            disabled={!canSubmit}
            onClick={() =>
              details
                ? act({
                    action: "details_release",
                    payment_method: method,
                    ...(postDelivery ? { post_delivery_pointer_id: postDelivery } : {}),
                    approved_text: text.trim(),
                  })
                : decision &&
                  act({
                    action: decision,
                    approved_text: text.trim(),
                    ...(needsNote ? { note: note.trim() } : {}),
                  })
            }
          >
            {t(details ? "Liberar dados para envio" : "Registrar decisão e enviar comunicação")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t(
              "O texto revisado será enviado à cliente. Confira o resultado neste caso; um pedido de envio ainda não é uma mensagem enviada.",
            )}
          </p>
        </>
      ) : null}
    </section>
  );
}
