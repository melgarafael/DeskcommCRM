"use client";

import { useState } from "react";
import { toast } from "sonner";
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
}

const VARIANT_LABELS: Record<LgpdRequestType, { button: string; title: string; description: string }> = {
  customer_data_request: {
    button: "Aprovar export",
    title: "Aprovar exportação de dados",
    description:
      "Ao confirmar, esta solicitação será colocada em fila para exportação dos dados do titular. A ação não pode ser desfeita.",
  },
  customer_redact: {
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

export function ApproveButton({ requestId, requestType, status }: ApproveButtonProps) {
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
          toast.success("Aprovação registrada — request mudou para processing");
          setOpen(false);
          setReason("");
        },
        onError: () => {
          toast.error("Falha ao aprovar a solicitação. Tente novamente.");
        },
      },
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <CheckCircle size={16} aria-hidden />
          {labels.button}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{labels.title}</AlertDialogTitle>
          <AlertDialogDescription>{labels.description}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="approved_reason">
            Justificativa{" "}
            <span className="text-muted-foreground text-xs">(mínimo 10 caracteres)</span>
          </Label>
          <Textarea
            id="approved_reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Descreva o motivo da aprovação manual desta solicitação…"
            rows={3}
            maxLength={500}
            className="resize-none"
            aria-describedby="approved_reason_hint"
          />
          <p id="approved_reason_hint" className="text-xs text-muted-foreground">
            {reason.trim().length}/500 caracteres
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={!isValid || isPending}
          >
            {isPending ? "Aprovando…" : "Confirmar aprovação"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
