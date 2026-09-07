"use client";

import { useT } from "@/hooks/i18n/useT";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Trash } from "@/lib/ui/icons";
import { useDeleteFollowupFlow } from "@/hooks/followup/useFollowupFlow";

type Props = {
  flowId: string;
  flowName: string;
  /** Depois de apagar o fluxo aberto no editor, volta pra lista. */
  redirectToList?: boolean;
  variant?: "outline" | "ghost";
  size?: "sm" | "default";
};

export function DeleteFollowupFlowButton({
  flowId,
  flowName,
  redirectToList = false,
  variant = "outline",
  size = "sm",
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const del = useDeleteFollowupFlow();

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className="text-destructive"
        disabled={del.isPending}
        data-testid="delete-followup-flow"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Trash size={14} aria-hidden className="mr-1" />
        {t("Excluir")}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Excluir")} &ldquo;{flowName}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("Inscrições e versões deste fluxo são apagadas junto. Não é possível desfazer.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={del.isPending}
              onClick={(e) => {
                e.preventDefault();
                del.mutate(flowId, {
                  onSuccess: () => {
                    setOpen(false);
                    if (redirectToList) router.push("/app/ai/followups");
                  },
                });
              }}
            >
              {del.isPending ? "Excluindo…" : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
