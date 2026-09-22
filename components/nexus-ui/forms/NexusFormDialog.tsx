"use client";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Diálogo de formulário único: cabeçalho + rodapé + estado ocupado.
 * Substitui as reimplementações `Dialog+Header+Footer+busy` por página.
 */
export function NexusFormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  submitLabel,
  cancelLabel,
  busy = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  submitLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onSubmit: () => void | Promise<void>;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="grid gap-4">{children}</div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel ?? t("Cancelar")}
          </Button>
          <Button
            onClick={() => {
              void onSubmit();
            }}
            disabled={busy}
          >
            {busy ? t("Salvando…") : (submitLabel ?? t("Salvar"))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
