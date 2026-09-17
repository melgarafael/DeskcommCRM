"use client";

import { useState } from "react";

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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ApiError } from "@/lib/api/types";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { PublishValidationError } from "@/lib/followup/validate-publish";
import { useT } from "@/hooks/i18n/useT";
import {
  useDisableFollowupFlow,
  usePublishFollowupFlow,
  useRollbackFollowupFlow,
  useSaveFollowupFlowDraft,
  useUpdateHandoffPolicy,
  type FollowupFlowDetailRow,
} from "@/hooks/followup/useFollowupFlow";
import { Trash, TreeStructure } from "@/lib/ui/icons";
import { FlowStatusBadge } from "../../_components/FlowStatusBadge";
import { DeleteFollowupFlowButton } from "../../_components/DeleteFollowupFlowButton";
import { TriggerConfigControl } from "./TriggerConfigControl";

interface Props {
  flowId: string;
  flow: FollowupFlowDetailRow;
  graph: FlowGraph;
  dirty: boolean;
  selection: "node" | "edge" | null;
  onDeleteSelection: () => void;
  onSaved: (graph: FlowGraph) => void;
  onPublishErrors: (errorsByNode: Record<string, string[]>) => void;
  onPublishSuccess: () => void;
  onAutoFit?: () => void;
  canAutoFit?: boolean;
}

const HANDOFF_LABEL: Record<FollowupFlowDetailRow["handoff_policy"], string> = {
  pause: "Pausar durante handoff",
  cancel: "Cancelar durante handoff",
  allow: "Permitir durante handoff",
};

export function PublishBar({
  flowId,
  flow,
  graph,
  dirty,
  selection,
  onDeleteSelection,
  onSaved,
  onPublishErrors,
  onPublishSuccess,
  onAutoFit,
  canAutoFit = false,
}: Props) {
  const t = useT();
  const [openDeleteSelection, setOpenDeleteSelection] = useState(false);
  const save = useSaveFollowupFlowDraft(flowId);
  const publish = usePublishFollowupFlow(flowId);
  const disable = useDisableFollowupFlow(flowId);
  const rollback = useRollbackFollowupFlow(flowId);
  const handoffPolicy = useUpdateHandoffPolicy(flowId);

  const onSave = () => {
    save.mutate(graph, { onSuccess: () => onSaved(graph) });
  };

  const onPublish = async () => {
    try {
      await save.mutateAsync(graph);
      onSaved(graph);
    } catch {
      return; // save's own onError already toasted — don't attempt publish on a failed save
    }

    publish.mutate(undefined, {
      onSuccess: () => onPublishSuccess(),
      onError: (err) => {
        if (err instanceof ApiError && err.code === "validation_failed") {
          const errors = (err.details?.errors as PublishValidationError[] | undefined) ?? [];
          const byNode: Record<string, string[]> = {};
          const flowLevel: string[] = [];
          for (const e of errors) {
            if (e.node_id) (byNode[e.node_id] ??= []).push(e.message);
            else flowLevel.push(e.message);
          }
          onPublishErrors(byNode);
          toast.error(t("Fluxo reprovado na validação — corrija os nós destacados."), {
            description: flowLevel.length > 0 ? flowLevel.join(" ") : undefined,
          });
          return;
        }
        showApiError(err);
      },
    });
  };

  const onDisable = () => disable.mutate();

  const canRollback = flow.versions_count > 1 && flow.previous_version_id !== null;
  const onRollback = () => {
    if (!flow.previous_version_id) return;
    rollback.mutate(flow.previous_version_id);
  };

  const busy = save.isPending || publish.isPending || disable.isPending || rollback.isPending;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold text-text">{flow.name}</h1>
        <FlowStatusBadge status={flow.status} />
        {dirty && (
          <Badge variant="warning" data-testid="dirty-indicator">
            {t("Alterações não salvas")}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TriggerConfigControl flowId={flowId} triggerConfig={flow.trigger_config} />

        <Select value={flow.handoff_policy} onValueChange={(v) => handoffPolicy.mutate(v as FollowupFlowDetailRow["handoff_policy"])}>
          <SelectTrigger className="w-56" aria-label={t("Política de handoff")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(HANDOFF_LABEL) as Array<keyof typeof HANDOFF_LABEL>).map((k) => (
              <SelectItem key={k} value={k}>
                {t(HANDOFF_LABEL[k])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button type="button" variant="secondary" size="sm" disabled={!dirty || busy} onClick={onSave}>
          {save.isPending ? t("Salvando…") : t("Salvar")}
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={onPublish} data-testid="publish-button">
          {publish.isPending ? t("Publicando…") : t("Publicar")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || flow.status === "disabled"}
          onClick={onDisable}
        >
          {t("Desativar")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !canRollback}
          onClick={onRollback}
          data-testid="rollback-button"
        >
          {t("Rollback")}
        </Button>
        {onAutoFit && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canAutoFit}
            onClick={onAutoFit}
            data-testid="auto-fit-flow"
          >
            <TreeStructure size={14} aria-hidden className="mr-1" />
            {t("Organizar")}
          </Button>
        )}
        {selection ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive"
              data-testid="delete-selection"
              onClick={() => setOpenDeleteSelection(true)}
            >
              <Trash size={14} aria-hidden className="mr-1" />
              {selection === "node" ? t("Excluir nó") : t("Excluir aresta")}
            </Button>
            <AlertDialog open={openDeleteSelection} onOpenChange={setOpenDeleteSelection}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {selection === "node" ? t("Excluir este nó?") : t("Excluir esta aresta?")}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {selection === "node"
                      ? t("Este nó e as arestas ligadas a ele são apagados. Não é possível desfazer.")
                      : t("A aresta entre os dois nós é apagada. Não é possível desfazer.")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(e) => {
                      e.preventDefault();
                      setOpenDeleteSelection(false);
                      onDeleteSelection();
                    }}
                  >
                    {t("Excluir")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : (
          <DeleteFollowupFlowButton flowId={flowId} flowName={flow.name} redirectToList />
        )}
      </div>
    </div>
  );
}
