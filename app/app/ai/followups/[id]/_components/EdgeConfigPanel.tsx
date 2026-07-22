"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ArrowRight } from "@/lib/ui/icons";
import { edgeConditionOptions, conditionKey } from "@/lib/followup/edge-condition-options";
import type { FlowEdge, FlowNode } from "@/lib/followup/graph-schema";

interface Props {
  sourceNode: FlowNode | undefined;
  targetNode: FlowNode | undefined;
  condition: FlowEdge["condition"];
  onChange: (condition: FlowEdge["condition"]) => void;
}

/**
 * Docked (non-modal) panel for the selected edge's routing condition — mirrors
 * NodeConfigPanel's shell/style. The option list is exhaustive per the source
 * node's type (`edgeConditionOptions`), so an `ai_classify` source can only
 * ever be wired to exactly what `validateFlowForPublish` accepts.
 */
export function EdgeConfigPanel({ sourceNode, targetNode, condition, onChange }: Props) {
  const options = edgeConditionOptions(sourceNode);
  const currentKey = conditionKey(condition);

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto" data-testid="edge-config-panel">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-text">Condição da aresta</h2>
        <p className="flex items-center gap-1.5 text-sm text-text-muted">
          <span className="truncate">{sourceNode?.label ?? "?"}</span>
          <ArrowRight size={12} aria-hidden className="shrink-0" />
          <span className="truncate">{targetNode?.label ?? "?"}</span>
        </p>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <Label htmlFor="edge-condition">Quando seguir por esta aresta</Label>
        <Select
          value={currentKey}
          onValueChange={(v) => {
            const option = options.find((o) => o.key === v);
            if (option) onChange(option.condition);
          }}
        >
          <SelectTrigger id="edge-condition">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {sourceNode?.type === "ai_classify" && (
          <p className="text-xs text-text-muted">
            As opções vêm das classes configuradas no nó "{sourceNode.label}".
          </p>
        )}
      </div>
    </div>
  );
}
