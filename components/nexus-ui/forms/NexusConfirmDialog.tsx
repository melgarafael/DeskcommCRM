"use client";

import { useState } from "react";

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
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

/**
 * Confirmação destrutiva única. Substitui as 4+ cópias de `AlertDialog` de
 * excluir espalhadas (webhooks, templates, admin, contatos).
 *
 * Controlado DE PROPÓSITO: o botão que abre vive aqui dentro, com `onClick`
 * de verdade. A forma alternativa (`trigger` como elemento, aberto pelo
 * `AlertDialogTrigger asChild` do pai) funciona em tela mas é invisível para
 * a varredura de botões mudos (`tests/unit/controle-decorativo`) — o clique
 * mora no avô, e o guarda acusa o botão de morto.
 */
export function NexusConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = true,
  busy = false,
  triggerLabel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  triggerLabel: React.ReactNode;
  onConfirm: () => void | Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  async function confirmar() {
    await onConfirm();
    setOpen(false);
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => (busy ? undefined : setOpen(o))}>
      <AlertDialogTrigger asChild>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => setOpen(true)}>
          {triggerLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelLabel ?? t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              void confirmar();
            }}
            className={danger ? "bg-error text-white hover:brightness-95" : undefined}
          >
            {busy ? t("Aguarde…") : (confirmLabel ?? t("Excluir"))}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
