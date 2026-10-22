"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NodeType } from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import { NOS_DA_SUPERFICIE } from "@/lib/followup/validate-publish";
import type { FollowupFlowSurface } from "@/lib/followup/api-schemas";
import { NODE_VISUALS } from "./nodes/nodeVisuals";

interface Props {
  onAdd: (type: NodeType) => void;
  /**
   * Superfície do fluxo: a paleta oferece SÓ as caixas que o motor dela executa
   * (`NOS_DA_SUPERFICIE`, a mesma lista do publish). Na prova do #1130 a paleta
   * do roteiro oferecia seis caixas que o motor recusava em silêncio.
   */
  surface?: FollowupFlowSurface;
  /** "mobile" = mesmo conteúdo dentro do Sheet que `FlowCanvas` abre abaixo de
   * `lg` — a barra fixa de 224px não cabia perto do canvas num celular. */
  variant?: "desktop" | "mobile";
}

/** Sidebar palette — click to add. Native HTML5 drag-and-drop wired in FlowCanvas (increment 3). */
export function NodePalette({ onAdd, variant = "desktop", surface = "followup" }: Props) {
  const t = useT();
  const isMobile = variant === "mobile";
  return (
    <aside
      className={cn(
        "flex flex-col gap-1.5 overflow-y-auto p-3",
        isMobile
          ? "h-full w-full"
          : "hidden w-56 shrink-0 border-r border-border bg-surface lg:flex",
      )}
      data-testid="node-palette"
    >
      <h2 className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-text-muted">
        {t("Adicionar nó")}
      </h2>
      {NOS_DA_SUPERFICIE[surface].map((tipo) => {
        const visual = NODE_VISUALS[tipo];
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
            {t(visual.paletteLabel)}
          </Button>
        );
      })}
    </aside>
  );
}
