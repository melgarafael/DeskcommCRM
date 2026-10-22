"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { useT } from "@/hooks/i18n/useT";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/**
 * O nó `internal_task` no canvas (#1540).
 *
 * Era a caixa que existia em tudo menos na tela: paleta, schema, publish e
 * motor a conheciam, e o `nodeTypes` do React Flow não — arrastá-la renderizava
 * o fallback cinza do React Flow, sem rótulo e sem configuração visível.
 */
export function InternalTaskNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.internal_task}
      label={data.label}
      subtitle={describeNodeConfig("internal_task", data.config, t)}
      selected={selected}
      errors={data.errors}
    />
  );
}
