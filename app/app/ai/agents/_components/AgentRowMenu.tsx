"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { DotsThree, PencilSimple, Copy, Pause, Play, Archive } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { deriveAgentStatus } from "./AgentStatusBadge";
import type { AgentRow } from "@/hooks/ai/useAgent";
import {
  archiveAgentAction,
  duplicateAgentAction,
  pauseAgentAction,
  unpauseAgentAction,
} from "../_actions";
import { RenameAgentDialog } from "./RenameAgentDialog";

interface Props {
  agent: AgentRow;
}

export function AgentRowMenu({ agent }: Props) {
  const t = useT();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const status = deriveAgentStatus(agent);
  const isPaused = status === "paused" || status === "draft";
  const isArchived = status === "archived";

  const run = (label: string, action: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
    startTransition(async () => {
      try {
        const res = await action();
        if (res.ok) {
          toast.success(label);
          router.refresh();
        } else {
          toast.error(res.message ?? `${t("Falha")}: ${res.error ?? "unknown"}`);
        }
      } catch {
        toast.error(t("Erro ao executar ação."));
      }
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("Menu de ações")}
            disabled={isPending}
            className="size-8"
          >
            <DotsThree size={18} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem asChild>
            <Link href={`/app/ai/agents/${agent.id}`} className="flex items-center gap-2">
              <PencilSimple size={14} aria-hidden /> {t("Editar")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isArchived}
            onSelect={() => run(t("Funcionário duplicado."), () => duplicateAgentAction(agent.id))}
          >
            <Copy size={14} aria-hidden className="mr-2" /> {t("Duplicar")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isArchived}
            onSelect={(e) => {
              e.preventDefault();
              setRenameOpen(true);
            }}
          >
            <PencilSimple size={14} aria-hidden className="mr-2" /> {t("Renomear")}
          </DropdownMenuItem>
          {isPaused ? (
            <DropdownMenuItem
              disabled={isArchived || agent.kind === "mcp_agent"}
              onSelect={() => run(t("Funcionário reativado."), () => unpauseAgentAction(agent.id))}
            >
              <Play size={14} aria-hidden className="mr-2" /> {t("Despausar")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={isArchived}
              onSelect={() => run(t("Funcionário pausado."), () => pauseAgentAction(agent.id))}
            >
              <Pause size={14} aria-hidden className="mr-2" /> {t("Pausar")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={isArchived}
            onSelect={(e) => {
              e.preventDefault();
              setArchiveOpen(true);
            }}
            className="text-destructive focus:text-destructive"
          >
            <Archive size={14} aria-hidden className="mr-2" /> {t("Arquivar")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameAgentDialog
        agent={agent}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Arquivar")} &ldquo;{agent.name}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "O funcionário deixa de responder e sai da equipe ativa. Treinamentos publicados e histórico são preservados para auditoria. Não é possível desarquivar pela interface nesta versão.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run(t("Funcionário arquivado."), () => archiveAgentAction(agent.id))
              }
            >
              {t("Arquivar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
