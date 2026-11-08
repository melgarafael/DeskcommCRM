"use client";

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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/i18n/useT";

export function IniciarAvaliacaoDialog({
  agendamentoId,
  onConfirm,
}: {
  agendamentoId: string;
  onConfirm: () => void;
}) {
  const t = useT();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <DropdownMenuItem onSelect={(e) => e.preventDefault()}>{t("Iniciar avaliação")}</DropdownMenuItem>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Iniciar avaliação")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              'O assistente de avaliação completo chegará em uma próxima entrega. Agora o status passa para "Em avaliação" e o vínculo com o agendamento',
            )}{" "}
            {agendamentoId.slice(0, 8)} {t("fica registrado.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Iniciar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
