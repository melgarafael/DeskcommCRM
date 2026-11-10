"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import {
  useCloseCaseWithoutReply,
  useReplyCase,
  type CaseStatus,
} from "@/hooks/ai/useCases";
import {
  CASE_ACTIONS,
  CASE_CLOSE_WITHOUT_REPLY,
  CASE_REPLY_DISABLED_REASON,
  type CasePanelAction,
} from "@/lib/ai/case-copy";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

/**
 * As ações do humano sobre um caso aberto (spec 15 §9): as 3 do `.../reply` e,
 * desde o #3810, a que ENCERRA SEM AVISAR o cliente (`.../close`). Só habilitado
 * em `awaiting_human` — nos outros estados a bola não está com o atendente, e o
 * motivo aparece em texto (nunca um botão desabilitado sem explicação).
 *
 * A 4ª opção mora na MESMA lista de rádio porque é a mesma pergunta ("o que você
 * quer fazer com este caso?"), mas o envio vai para outra rota e o corpo é outro
 * (`{note}` em vez de `{action, body}`) — daí o desvio no `handleSubmit`.
 */
export function CaseReplyPanel({ caseId, status }: { caseId: string; status: CaseStatus }) {
  const t = useT();
  // Sem pré-seleção de propósito: as ações têm efeitos muito diferentes (duas
  // delas FECHAM o caso) e não há desfazer. Um default marcado faria quem digitou
  // pensando em "pedir info ao cliente" encerrar o caso sem perceber.
  const [action, setAction] = useState<CasePanelAction | null>(null);
  const [body, setBody] = useState("");
  const reply = useReplyCase();
  const encerrar = useCloseCaseWithoutReply();

  const disabled = status !== "awaiting_human";
  const disabledReason = CASE_REPLY_DISABLED_REASON[status];
  const semAviso = action === CASE_CLOSE_WITHOUT_REPLY.action;
  const pendente = reply.isPending || encerrar.isPending;
  const canSubmit = !disabled && action !== null && body.trim().length > 0 && !pendente;

  function limpar() {
    setBody("");
    setAction(null);
  }

  function handleSubmit() {
    if (action === null) return;
    // #3810: a nota aqui é OBRIGATÓRIA (o servidor devolve 400 sem ela) — ela
    // não vai para o cliente, vai para a linha do tempo de quem abrir o caso.
    if (action === CASE_CLOSE_WITHOUT_REPLY.action) {
      encerrar.mutate(
        { id: caseId, note: body.trim() },
        {
          onSuccess: () => {
            toast.success(t("Caso encerrado. O cliente não recebeu mensagem."));
            limpar();
          },
          onError: (err) => showApiError(err),
        },
      );
      return;
    }
    reply.mutate(
      { id: caseId, action, body: body.trim() },
      {
        onSuccess: (result) => {
          if (result.delivery === "service_stale") toast.info(t("Resposta registrada; não repassada porque o atendimento mudou. Revise a conversa."));
          else toast.success(t("Resposta registrada para processamento."));
          limpar();
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
        {[...CASE_ACTIONS, CASE_CLOSE_WITHOUT_REPLY].map((opt) => (
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
        placeholder={
          semAviso
            ? t("Escreva por que este caso não precisa mais de resposta (o cliente não recebe esta nota).")
            : t("Escreva sua resposta para a IA...")
        }
        rows={3}
      />
      {!disabled && action === null ? (
        <p className="text-xs text-muted-foreground">{t("Escolha uma das opções acima para enviar.")}</p>
      ) : null}
      {semAviso ? (
        <p className="text-xs text-muted-foreground">
          {t("A nota é obrigatória e fica só no caso. Nada é enviado ao cliente.")}
        </p>
      ) : null}
      <Button onClick={handleSubmit} disabled={!canSubmit}>
        {pendente
          ? t("Enviando...")
          : semAviso
            ? t("Encerrar caso")
            : t("Enviar")}
      </Button>
    </div>
  );
}
