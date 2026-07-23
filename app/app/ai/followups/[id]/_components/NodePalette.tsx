"use client";

import { Button } from "@/components/ui/button";
import type { NodeType } from "@/lib/followup/graph-schema";
import { NODE_VISUAL_LIST } from "./nodes/nodeVisuals";

interface Props {
  onAdd: (type: NodeType) => void;
}

/** Sidebar palette — click to add. Native HTML5 drag-and-drop wired in FlowCanvas (increment 3). */
export function NodePalette({ onAdd }: Props) {
  return (
    <aside
      className="flex w-56 shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-border bg-surface p-3"
      data-testid="node-palette"
    >
      <h2 className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-text-muted">
        Adicionar nó
      </h2>
      {NODE_VISUAL_LIST.map((visual) => {
        const Icon = visual.icon;
        return (
          <Button
            key={visual.type}
            type="button"
            variant="secondary"
            size="sm"
            className="justify-start gap-2"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-followup-node-type", visual.type);
              e.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => onAdd(visual.type)}
            data-testid={`palette-add-${visual.type}`}
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${visual.chipClassName}`}
            >
              <Icon size={14} aria-hidden />
            </span>
            {visual.paletteLabel}
          </Button>
        );
      })}
    </aside>
  );
}
