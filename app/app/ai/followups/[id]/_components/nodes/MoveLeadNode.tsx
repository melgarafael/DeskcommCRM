"use client";

import type { NodeProps } from "@xyflow/react";

import type { RFNode } from "@/lib/followup/graph-mappers";
import { useT } from "@/hooks/i18n/useT";
import { NODE_VISUALS, describeNodeConfig } from "./nodeVisuals";
import { NodeCard } from "./NodeCard";

/**
 * O nó `move_lead` no canvas (#2065) — "mover lead no funil".
 *
 * Mesma forma do `internal_task`: a paleta, o schema, o publish e o motor já a
 * conhecem; sem esta linha o React Flow renderizaria o fallback cinza, sem
 * rótulo e sem subtítulo.
 */
export function MoveLeadNode({ id, data, selected }: NodeProps<RFNode>) {
  const t = useT();
  return (
    <NodeCard
      id={id}
      visual={NODE_VISUALS.move_lead}
      label={data.label}
      subtitle={describeNodeConfig("move_lead", data.config, t)}
      selected={selected}
      errors={data.errors}
    />
  );
}
