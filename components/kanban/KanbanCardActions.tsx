"use client";
import { useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DotsThree, PencilSimple, Users } from "@/lib/ui/icons";
import { useWinLead, useEditLead } from "@/hooks/kanban/useUpdateLead";
import { useBulkAction } from "@/hooks/kanban/useBulkAction";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useAssignableAgents } from "@/hooks/kanban/useAssignableAgents";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { LoseLeadDialog } from "./LoseLeadDialog";
import { EditLeadDialog } from "./EditLeadDialog";
import type { Lead } from "@/lib/types/leads";

interface KanbanCardActionsProps {
  lead: Lead;
  pipelineId: string;
}

export function KanbanCardActions({ lead, pipelineId }: KanbanCardActionsProps) {
  const t = useT();
  const [loseOpen, setLoseOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const winMutation = useWinLead(pipelineId);
  const editMutation = useEditLead(pipelineId);
  // Excluir um card é a mesma ação da barra de seleção, com um id só: mesma
  // rota, mesmo gate de papel, mesmo evento e auditoria.
  const bulk = useBulkAction(pipelineId);
  // spec 13 §4: escrita no funil é agent+ — viewer não reatribui (a rota
  // PATCH também recusa; aqui é só não oferecer o que seria negado).
  const canAssign = usePermission("pipeline.move_card");
  const { data: members } = useAssignableMembers(canAssign);
  // A rota já devolve só agente ativo e não arquivado — é o picker.
  const { data: agents } = useAssignableAgents(canAssign);

  const reassignToUser = (ownerUserId: string | null) => {
    if (ownerUserId === lead.owner_user_id) return;
    editMutation.mutate({ leadId: lead.id, patch: { owner_user_id: ownerUserId } });
  };

  /** Transferir para um agente: o handler zera o dono humano e deriva owner_kind. */
  const reassignToAgent = (agentId: string) => {
    if (agentId === lead.owner_agent_id) return;
    editMutation.mutate({ leadId: lead.id, patch: { owner_agent_id: agentId } });
  };

  const clearOwner = () => {
    if (lead.owner_user_id === null && lead.owner_agent_id === null) return;
    editMutation.mutate({
      leadId: lead.id,
      patch: lead.owner_agent_id ? { owner_agent_id: null } : { owner_user_id: null },
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            // Visível por padrão e escondido até o hover SÓ onde existe hover:
            // no toque não há hover, e `opacity-0` deixava o menu inalcançável.
            // Mesmo padrão de `components/inbox/MessageBubble.tsx`.
            className="h-7 w-7 shrink-0 opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 data-[state=open]:opacity-100"
            onClick={(e) => e.stopPropagation()}
            aria-label={t("Ações do lead")}
          >
            <DotsThree size={16} weight="bold" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenuItem
            onSelect={() => {
              setEditOpen(true);
            }}
          >
            <PencilSimple size={14} className="mr-2" /> {t("Editar")}
          </DropdownMenuItem>
          {canAssign && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Users size={14} className="mr-2" /> {t("Responsável")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem
                  disabled={
                    editMutation.isPending ||
                    (lead.owner_user_id === null && lead.owner_agent_id === null)
                  }
                  onSelect={clearOwner}
                >
                  {t("Sem responsável")}
                </DropdownMenuItem>
                {(members ?? []).length > 0 && <DropdownMenuSeparator />}
                {(members ?? []).map((m) => (
                  <DropdownMenuItem
                    key={m.user_id}
                    disabled={editMutation.isPending || m.user_id === lead.owner_user_id}
                    onSelect={() => reassignToUser(m.user_id)}
                  >
                    {m.full_name ?? t("Sem nome")}
                  </DropdownMenuItem>
                ))}
                {(agents ?? []).length > 0 && <DropdownMenuSeparator />}
                {(agents ?? []).map((a) => (
                  <DropdownMenuItem
                    key={a.agent_id}
                    disabled={editMutation.isPending || a.agent_id === lead.owner_agent_id}
                    onSelect={() => reassignToAgent(a.agent_id)}
                  >
                    {a.name}
                    {a.version_number != null && (
                      <span className="ml-1.5 font-mono text-[10px] text-text-muted">
                        v{a.version_number}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem
            disabled={winMutation.isPending}
            onSelect={() => {
              winMutation.mutate({ leadId: lead.id });
            }}
          >
            {t("Marcar como ganho")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setLoseOpen(true);
            }}
          >
            {t("Marcar como perdido")}
          </DropdownMenuItem>
          {canAssign && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-error-fg"
                disabled={bulk.isPending}
                onSelect={() => {
                  setDeleteOpen(true);
                }}
              >
                {t("Excluir")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{`${t("Excluir")} "${lead.title}"?`}</DialogTitle>
            <DialogDescription>
              {t(
                "O card sai do funil com o histórico de atividades. O contato e as conversas continuam. Esta ação não pode ser desfeita.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              {t("Cancelar")}
            </Button>
            <Button
              variant="destructive"
              disabled={bulk.isPending}
              onClick={() =>
                bulk.mutate(
                  { action: "delete", lead_ids: [lead.id], params: {} },
                  { onSuccess: () => setDeleteOpen(false) },
                )
              }
            >
              {t("Excluir")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LoseLeadDialog
        open={loseOpen}
        onOpenChange={setLoseOpen}
        leadId={lead.id}
        pipelineId={pipelineId}
      />
      <EditLeadDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        lead={lead}
        pipelineId={pipelineId}
      />
    </>
  );
}
