"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useReplyCase, type CaseHumanAction, type CaseStatus } from "@/hooks/ai/useCases";
import { CASE_ACTIONS, CASE_REPLY_DISABLED_REASON } from "@/lib/ai/case-copy";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

/**
 * As 3 ações do humano sobre um caso aberto (spec 15 §9). Só habilitado em
 * `awaiting_human` — nos outros estados a bola não está com o atendente, e
 * o motivo aparece em texto (nunca um botão desabilitado sem explicação).
 */
export function CaseReplyPanel({ caseId, status }: { caseId: string; status: CaseStatus }) {
  const t = useT();
  // Sem pré-seleção de propósito: as 3 ações têm efeitos muito diferentes (uma
  // delas FECHA o caso) e não há desfazer. Um default marcado faria quem digitou
  // pensando em "pedir info ao cliente" encerrar o caso sem perceber.
  const [action, setAction] = useState<CaseHumanAction | null>(null);
  const [body, setBody] = useState("");
  const reply = useReplyCase();

  const disabled = status !== "awaiting_human";
  const disabledReason = CASE_REPLY_DISABLED_REASON[status];
  const canSubmit = !disabled && action !== null && body.trim().length > 0 && !reply.isPending;

  function handleSubmit() {
    if (action === null) return;
    reply.mutate(
      { id: caseId, action, body: body.trim() },
      {
        onSuccess: (result) => {
          if (result.delivery === "service_stale") toast.info(t("Resposta registrada; não repassada porque o atendimento mudou. Revise a conversa."));
          else toast.success(t("Resposta registrada para processamento."));
          setBody("");
          setAction(null);
        },
        onError: (err) => showApiError(err),
      },
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold">{t("O que você quer fazer?")}</h3>
      {disabled ? <p className="text-xs text-muted-foreground">{disabledReason ? t(disabledReason) : null}</p> : null}

      <div className="flex flex-col gap-2" role="radiogroup" aria-label={t("O que você quer fazer?")}>
        {CASE_ACTIONS.map((opt) => (
          <button
            key={opt.action}
            type="button"
            role="radio"
            disabled={disabled}
            aria-checked={action === opt.action}
            onClick={() => setAction(opt.action)}
            className={cn(
              "rounded-sm border p-3 text-left transition-colors",
              action === opt.action ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong",
              disabled && "cursor-not-allowed opacity-55",
            )}
          >
            <p className="text-sm font-medium">{t(opt.label)}</p>
            <p className="text-xs text-muted-foreground">{t(opt.help)}</p>
          </button>
        ))}
      </div>

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={disabled}
        placeholder={t("Escreva sua resposta para a IA...")}
        rows={3}
      />
      {!disabled && action === null ? (
        <p className="text-xs text-muted-foreground">{t("Escolha uma das opções acima para enviar.")}</p>
      ) : null}
      <Button onClick={handleSubmit} disabled={!canSubmit}>
        {reply.isPending ? t("Enviando...") : t("Enviar")}
      </Button>
    </div>
  );
}
