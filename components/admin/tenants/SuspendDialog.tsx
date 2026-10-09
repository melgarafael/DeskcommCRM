"use client";
import { useState } from "react";
import { z } from "zod";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useSuspendTenant } from "@/hooks/useSuspendTenant";
import { useT } from "@/hooks/i18n/useT";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const reasonSchema = z.string().min(10, "Mínimo 10 caracteres").max(500, "Máximo 500 caracteres");

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SuspendDialogProps {
  open: boolean;
  onClose: () => void;
  organizationId: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SuspendDialog({ open, onClose, organizationId }: SuspendDialogProps) {
  const t = useT();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const suspend = useSuspendTenant();
  const validation = reasonSchema.safeParse(reason);
  const isValid = validation.success;

  function handleConfirm() {
    const parsed = reasonSchema.safeParse(reason);
    if (!parsed.success) {
      setError(t(parsed.error.issues[0]?.message ?? "Razão inválida"));
      return;
    }
    suspend.mutate(
      { id: organizationId, reason: parsed.data },
      {
        onSuccess: () => {
          setReason("");
          setError(null);
          onClose();
        },
      },
    );
  }

  function handleClose() {
    setReason("");
    setError(null);
    onClose();
  }

  return (
    <AlertDialog open={open} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Suspender tenant")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "A empresa perde o acesso, e a IA, os envios e as automações dela param. Mensagens na fila e tarefas agendadas são descartadas e não saem ao reativar; os follow-ups em andamento retomam de onde pararam. As mensagens que chegarem continuam gravadas.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="suspend-reason">
            {t("Motivo da suspensão")}{" "}
            <span className="text-muted-foreground text-xs font-normal">
              ({reason.length}/500)
            </span>
          </Label>
          <Textarea
            id="suspend-reason"
            placeholder={t("Descreva o motivo da suspensão (mínimo 10 caracteres)...")}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            rows={4}
            maxLength={500}
            aria-describedby={error ? "suspend-reason-error" : undefined}
          />
          {error && (
            <p id="suspend-reason-error" className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleClose}>{t("Cancelar")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={!isValid || suspend.isPending}
          >
            {suspend.isPending ? t("Suspendendo...") : t("Confirmar suspensão")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
