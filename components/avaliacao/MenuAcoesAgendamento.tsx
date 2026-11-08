"use client";

import { toast } from "sonner";

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMutacaoAgendamento } from "@/hooks/avaliacao/useMutacaoAgendamento";
import { useT } from "@/hooks/i18n/useT";
import { copyToClipboard } from "@/lib/clipboard";
import type { StatusAvaliacao } from "@/lib/avaliacao/status";
import { DotsThree } from "@/lib/ui/icons";

import type { AgendamentoAvaliacao } from "./tipos";
import { IniciarAvaliacaoDialog } from "./IniciarAvaliacaoDialog";

export function MenuAcoesAgendamento({
  agendamento,
  onEditar,
}: {
  agendamento: AgendamentoAvaliacao;
  onEditar: () => void;
}) {
  const t = useT();
  const { acao, excluir, copiarConfirmacao } = useMutacaoAgendamento();
  const status = agendamento.status as StatusAvaliacao;

  const podeIniciar = status === "agendado" || status === "atrasado";
  const podeCancelar = ["agendado", "atrasado", "aguardando"].includes(status);
  const podeReativar = status === "cancelado";
  const podeAguardando = status === "agendado";
  const podeReverter = status === "aguardando";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={t("Ações")}>
          <DotsThree className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          onClick={async () => {
            const texto = await copiarConfirmacao.mutateAsync(agendamento.id);
            await copyToClipboard(texto);
            toast.success("Confirmação copiada para a área de transferência.");
          }}
        >
          {t("Copiar confirmação")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEditar}>Editar</DropdownMenuItem>
        {podeCancelar && (
          <DropdownMenuItem onClick={() => acao.mutate({ id: agendamento.id, acao: "cancelar" })}>
            Cancelar
          </DropdownMenuItem>
        )}
        {podeReativar && (
          <DropdownMenuItem onClick={() => acao.mutate({ id: agendamento.id, acao: "reativar" })}>
            Reativar
          </DropdownMenuItem>
        )}
        {podeAguardando && (
          <DropdownMenuItem onClick={() => acao.mutate({ id: agendamento.id, acao: "aguardando" })}>
            Marcar aguardando
          </DropdownMenuItem>
        )}
        {podeReverter && (
          <DropdownMenuItem onClick={() => acao.mutate({ id: agendamento.id, acao: "reverter" })}>
            {t("Reverter para agendado")}
          </DropdownMenuItem>
        )}
        {podeIniciar && (
          <>
            <DropdownMenuSeparator />
            <IniciarAvaliacaoDialog
              agendamentoId={agendamento.id}
              onConfirm={() => acao.mutate({ id: agendamento.id, acao: "iniciar_avaliacao" })}
            />
          </>
        )}
        <DropdownMenuSeparator />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="text-destructive">
              Excluir
            </DropdownMenuItem>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Excluir agendamento?</AlertDialogTitle>
              <AlertDialogDescription>
                {t("Esta ação é irreversível. O agendamento será removido permanentemente.")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Voltar</AlertDialogCancel>
              <AlertDialogAction onClick={() => excluir.mutate(agendamento.id)}>Excluir</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
