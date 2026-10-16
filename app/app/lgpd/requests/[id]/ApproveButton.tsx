"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { CheckCircle } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useApproveLgpdRequest } from "@/hooks/useApproveLgpdRequest";
import type { LgpdRequestType } from "@/hooks/useLgpdRequests";

interface ApproveButtonProps {
  requestId: string;
  requestType: LgpdRequestType;
  status: string;
  /** Nome e destino do envio: quem aprova confere a pessoa ANTES de o dado sair (doc 134). */
  titular?: { nome: string | null; email_destino: string | null };
}

const VARIANT_LABELS: Record<LgpdRequestType, { button: string; title: string; description: string }> = {
  data_request: {
    button: "Aprovar export",
    title: "Aprovar exportação de dados",
    description:
      "Ao confirmar, os dados do titular são exportados e enviados para o e-mail abaixo. Confira se é a pessoa certa: o envio não pode ser desfeito.",
  },
  redact: {
    button: "Aprovar anonimização",
    title: "Aprovar anonimização de contato",
    description:
      "Ao confirmar, todos os dados pessoais do titular serão anonimizados (irreversível). O histórico de timestamps é preservado.",
  },
  store_redact: {
    button: "Aprovar anonimização (tenant)",
    title: "Aprovar anonimização de tenant",
    description:
      "Ao confirmar, todos os dados pessoais do tenant serão anonimizados (irreversível). Esta ação afeta todos os contatos do tenant.",
  },
};

export function ApproveButton({ requestId, requestType, status, titular }: ApproveButtonProps) {
  const t = useT();
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const { mutate, isPending } = useApproveLgpdRequest();

  // Only show if status is 'received'
  if (status !== "received") return null;

  const labels = VARIANT_LABELS[requestType];
  const isValid = reason.trim().length >= 10;

  function handleConfirm() {
    if (!isValid) return;
    mutate(
      { id: requestId, approved_reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success(t("Aprovação registrada — request mudou para processing"));
          setOpen(false);
          setReason("");
        },
        onError: () => {
          toast.error(t("Falha ao aprovar a solicitação. Tente novamente."));
        },
      },
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <CheckCircle size={16} aria-hidden />
          {t(labels.button)}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(labels.title)}</AlertDialogTitle>
          <AlertDialogDescription>{t(labels.description)}</AlertDialogDescription>
        </AlertDialogHeader>

        {requestType === "data_request" && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <dt className="text-muted-foreground">{t("Titular")}</dt>
            <dd className="font-medium break-words">
              {titular?.nome ?? t("Sem nome no cadastro")}
            </dd>
            <dt className="text-muted-foreground">{t("Envio para")}</dt>
            <dd className="font-medium break-all">
              {titular?.email_destino ?? t("Sem e-mail: o arquivo fica para entrega manual")}
            </dd>
          </dl>
        )}

        <div className="space-y-2 py-2">
          <Label htmlFor="approved_reason">
            {t("Justificativa")}{" "}
            <span className="text-muted-foreground text-xs">({t("mínimo 10 caracteres")})</span>
          </Label>
          <Textarea
            id="approved_reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("Descreva o motivo da aprovação manual desta solicitação…")}
            rows={3}
            maxLength={500}
            className="resize-none"
            aria-describedby="approved_reason_hint"
          />
          <p id="approved_reason_hint" className="text-xs text-muted-foreground">
            {reason.trim().length}/500 {t("caracteres")}
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={!isValid || isPending}
          >
            {isPending ? t("Aprovando…") : t("Confirmar aprovação")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
