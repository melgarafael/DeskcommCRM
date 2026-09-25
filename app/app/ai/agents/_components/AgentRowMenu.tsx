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
  const isDefault = agent.is_default;

  const run = (label: string, action: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
    startTransition(async () => {
      try {
        const res = await action();
        if (res.ok) {
          toast.success(label);
          router.refresh();
        } else {
          const message =
            res.error === "cannot_archive_default"
              ? t("O agent padrão da organização não pode ser arquivado.")
              : res.message ?? `${t("Falha")}: ${res.error ?? "unknown"}`;
          toast.error(message);
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
            onSelect={() => run(t("Agent duplicado."), () => duplicateAgentAction(agent.id))}
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
              disabled={isArchived}
              onSelect={() => run(t("Agent reativado."), () => unpauseAgentAction(agent.id))}
            >
              <Play size={14} aria-hidden className="mr-2" /> {t("Despausar")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={isArchived}
              onSelect={() => run(t("Agent pausado."), () => pauseAgentAction(agent.id))}
            >
              <Pause size={14} aria-hidden className="mr-2" /> {t("Pausar")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={isArchived || isDefault}
            title={
              isDefault
                ? t("O agent padrão da organização não pode ser arquivado.")
                : undefined
            }
            onSelect={(e) => {
              e.preventDefault();
              setArchiveOpen(true);
            }}
            // O item desabilitado herda `pointer-events-none`, e sem hover o
            // `title` acima nunca aparece. O Radix já recusa selecionar item
            // desabilitado, então devolver o ponteiro não reabre o clique.
            className="text-destructive focus:text-destructive data-[disabled]:pointer-events-auto"
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
                "O agent deixa de responder gatilhos e some das listas ativas. Versões publicadas são preservadas para auditoria. Não é possível desarquivar pela UI nesta versão.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run(t("Agent arquivado."), () => archiveAgentAction(agent.id))
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
