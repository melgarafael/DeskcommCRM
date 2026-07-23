"use client";

import { toast } from "sonner";

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
import {
  useDisableFollowupFlow,
  usePublishFollowupFlow,
  useRollbackFollowupFlow,
  useSaveFollowupFlowDraft,
  useUpdateHandoffPolicy,
  type FollowupFlowDetailRow,
} from "@/hooks/followup/useFollowupFlow";
import { FlowStatusBadge } from "../../_components/FlowStatusBadge";
import { TriggerConfigControl } from "./TriggerConfigControl";

interface Props {
  flowId: string;
  flow: FollowupFlowDetailRow;
  graph: FlowGraph;
  dirty: boolean;
  onSaved: (graph: FlowGraph) => void;
  onPublishErrors: (errorsByNode: Record<string, string[]>) => void;
  onPublishSuccess: () => void;
}

const HANDOFF_LABEL: Record<FollowupFlowDetailRow["handoff_policy"], string> = {
  pause: "Pausar durante handoff",
  cancel: "Cancelar durante handoff",
  allow: "Permitir durante handoff",
};

export function PublishBar({ flowId, flow, graph, dirty, onSaved, onPublishErrors, onPublishSuccess }: Props) {
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
          toast.error("Fluxo reprovado na validação — corrija os nós destacados.", {
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
            Alterações não salvas
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TriggerConfigControl flowId={flowId} triggerConfig={flow.trigger_config} />

        <Select value={flow.handoff_policy} onValueChange={(v) => handoffPolicy.mutate(v as FollowupFlowDetailRow["handoff_policy"])}>
          <SelectTrigger className="w-56" aria-label="Política de handoff">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(HANDOFF_LABEL) as Array<keyof typeof HANDOFF_LABEL>).map((k) => (
              <SelectItem key={k} value={k}>
                {HANDOFF_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button type="button" variant="secondary" size="sm" disabled={!dirty || busy} onClick={onSave}>
          {save.isPending ? "Salvando…" : "Salvar"}
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={onPublish} data-testid="publish-button">
          {publish.isPending ? "Publicando…" : "Publicar"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || flow.status === "disabled"}
          onClick={onDisable}
        >
          Desativar
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !canRollback}
          onClick={onRollback}
          data-testid="rollback-button"
        >
          Rollback
        </Button>
      </div>
    </div>
  );
}
